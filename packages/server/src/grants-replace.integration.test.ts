import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant, Message, TokenVault } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { markNeedsReauth, type CiphertextVault } from "./gmail-access.js";
import { replaceEarlierGrants } from "./grants-replace.js";
import { MemoryStore, type GrantStore } from "./store.js";
import { syncGmailGrant } from "./sync/gmail-sync.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(text, params)).rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

/** The shipped report without psql's \echo lines and comments, split into its queries. */
const REPORT = readFileSync(new URL("../../../scripts/shared-address-report.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("\\echo") && !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);

function grant(id: string, externalUserId: string, status: Grant["status"], email: string): Grant {
  return {
    id,
    tenantId: "default",
    externalUserId,
    provider: "gmail",
    email,
    status,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
    updatedAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`,
  };
}

describe("shared-address report and replacement on Postgres (#371)", () => {
  it("counts the issue's three grants before and none live-shared after a connect", async () => {
    assert.equal(REPORT.length, 2, "summary and per-grant queries");
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const store = new PostgresStore(db, { masterKey: "test-master-key-at-least-16" });
    const vault = new PostgresTokenVault(db, "test-master-key-at-least-16");
    await store.ready();

    // The situation found on 2026-10-13: one inbox, three identities.
    await store.putGrant(grant("grant_1", "3f2a9c1e-uuid", "active", "owner@gmail.com"));
    await store.putGrant(grant("grant_2", "anon_9b1d", "needs_reauth", "Owner@gmail.com"));
    await store.putGrant(grant("grant_3", "google:1077", "needs_reauth", "owner@gmail.com"));
    await store.putGrant(grant("grant_4", "anon_other", "active", "someone@gmail.com"));
    for (const id of ["grant_1", "grant_2", "grant_3"]) {
      await vault.seal(`1//refresh-${id}`, { grantId: id, tenantId: "default" });
    }

    const [summary, detail] = REPORT as [string, string];
    const before = (await pg.query<Record<string, unknown>>(summary)).rows;
    assert.deepEqual(before, [
      {
        tenant: "default",
        shared_addresses: 1,
        addresses_with_several_live_grants: 1,
        grants_on_shared_addresses: 3,
        live_grants_on_shared_addresses: 3,
      },
    ]);
    const rows = (await pg.query<{ grant_id: string; identity_kind: string }>(detail)).rows;
    assert.deepEqual(
      rows.map((r) => [r.grant_id, r.identity_kind]),
      [
        ["grant_1", "account"],
        ["grant_2", "anonymous"],
        ["grant_3", "google"],
      ],
    );
    assert.equal(JSON.stringify(rows).includes("@"), false, "no address in the report");

    // The owner connects again from the Google sign-in identity.
    const fresh = grant("grant_5", "google:1077", "active", "owner@gmail.com");
    await store.putGrant(fresh);
    await vault.seal("1//refresh-new", { grantId: fresh.id, tenantId: "default" });
    const replaced = await replaceEarlierGrants({ store, vault, grant: fresh });
    assert.deepEqual(replaced, ["grant_1", "grant_2", "grant_3"]);

    const after = (await pg.query<Record<string, unknown>>(summary)).rows;
    assert.deepEqual(after, [
      {
        tenant: "default",
        shared_addresses: 1,
        addresses_with_several_live_grants: 0,
        grants_on_shared_addresses: 4,
        live_grants_on_shared_addresses: 1,
      },
    ]);
    assert.deepEqual((await pg.query(detail)).rows, []);

    const old = await store.getGrant("grant_2");
    assert.equal(old?.status, "revoked");
    assert.equal(old?.replacedBy, "grant_5");
    assert.equal(await vault.getCiphertext("grant_2"), undefined);
    assert.equal((await store.getGrant("grant_4"))?.status, "active", "other mailbox untouched");
    assert.equal((await store.getGrant("grant_5"))?.replacedBy, undefined);
  });
});

type Backend = {
  name: string;
  make(): Promise<{ store: GrantStore; vault: TokenVault & CiphertextVault }>;
};

const BACKENDS: Backend[] = [
  {
    name: "memory",
    async make() {
      return { store: new MemoryStore(), vault: new MemoryTokenVault("test-master-key-at-least-16") };
    },
  },
  {
    name: "postgres",
    async make() {
      const db = new PgDatabase(new PgliteExecutor(new PGlite()));
      const store = new PostgresStore(db, { masterKey: "test-master-key-at-least-16" });
      await store.ready();
      return { store, vault: new PostgresTokenVault(db, "test-master-key-at-least-16") };
    },
  },
];

const ADDRESS = "owner@gmail.com";

function cached(grantId: string, n: number): Message {
  const at = "2026-10-01T12:00:00.000Z";
  return {
    id: `msg_${grantId}_${n}`,
    grantId,
    providerMessageId: `p${n}`,
    subject: `Subject ${n}`,
    snippet: "",
    from: [{ email: "recruiter@example.com" }],
    to: [{ email: ADDRESS }],
    sentAt: at,
    receivedAt: at,
    folderIds: ["INBOX"],
    hasAttachments: false,
  };
}

async function liveGrant(
  store: GrantStore,
  vault: TokenVault,
  id: string,
  externalUserId: string,
): Promise<Grant> {
  const g = grant(id, externalUserId, "active", ADDRESS);
  await store.putGrant(g);
  await vault.seal(`1//refresh-${id}`, { grantId: id, tenantId: "default" });
  return g;
}

for (const backend of BACKENDS) {
  describe(`concurrent Connects for one address (${backend.name})`, () => {
    it("a late retire step of the older Connect does not retire the newer grant", async () => {
      const { store, vault } = await backend.make();
      // A's callback saved grant A and is still sealing; B's callback saves B
      // and retires A; then A's retire step runs.
      const a = await liveGrant(store, vault, "grant_1", "anon_1");
      const b = await liveGrant(store, vault, "grant_2", "google:1");
      await store.upsertMessages([cached(b.id, 1)]);

      assert.deepEqual(await replaceEarlierGrants({ store, vault, grant: b }), [a.id]);
      assert.deepEqual(await replaceEarlierGrants({ store, vault, grant: a }), [], "A retires nothing");

      const live = await store.findLiveGrantsByAddress("default", "gmail", ADDRESS);
      assert.deepEqual(live.map((g) => g.id), [b.id], "exactly one live grant: B");
      assert.equal((await store.getGrant(b.id))?.replacedBy, undefined);
      assert.ok(await vault.getCiphertext(b.id), "B keeps its token");
      assert.deepEqual(await store.listMessageIds(b.id), ["p1"], "B keeps its cache");
      assert.equal((await store.getGrant(a.id))?.replacedBy, b.id);
      assert.equal(await vault.getCiphertext(a.id), undefined);
    });

    it("breaks a createdAt tie on id, in both orders", async () => {
      const { store, vault } = await backend.make();
      const at = "2026-10-05T10:00:00.000Z";
      const low: Grant = { ...grant("grant_1", "u1", "active", ADDRESS), id: "grant_aaa", createdAt: at };
      const high: Grant = { ...grant("grant_1", "u2", "active", ADDRESS), id: "grant_zzz", createdAt: at };
      for (const g of [low, high]) {
        await store.putGrant(g);
        await vault.seal("1//r", { grantId: g.id, tenantId: "default" });
      }
      assert.deepEqual(await replaceEarlierGrants({ store, vault, grant: low }), []);
      assert.deepEqual(await replaceEarlierGrants({ store, vault, grant: high }), [low.id]);
      const live = await store.findLiveGrantsByAddress("default", "gmail", ADDRESS);
      assert.deepEqual(live.map((g) => g.id), [high.id]);
    });
  });

  describe(`a sync running while its grant is retired (${backend.name})`, () => {
    let server: Server;
    let base = "";
    /** Runs while Gmail is answering the sync's message list, i.e. mid-sync. */
    let duringList: () => Promise<void> = async () => {};
    let listStatus = 200;

    before(async () => {
      server = createServer(async (req, res) => {
        const url = req.url ?? "/";
        req.resume();
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (url.startsWith("/token")) return json(200, { access_token: "ya29.x", expires_in: 3600 });
        if (url.startsWith("/gmail/v1/users/me/profile")) {
          return json(200, { emailAddress: ADDRESS, historyId: "100" });
        }
        if (url.startsWith("/gmail/v1/users/me/messages/")) {
          const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
          return json(200, {
            id,
            threadId: id,
            labelIds: ["INBOX"],
            snippet: "late",
            internalDate: "1710000000000",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "Subject", value: "late" },
              ],
              body: { data: Buffer.from("late").toString("base64url") },
            },
          });
        }
        if (url.startsWith("/gmail/v1/users/me/messages")) {
          await duringList();
          if (listStatus !== 200) {
            return json(listStatus, { error: { code: listStatus, message: "unauthorized" } });
          }
          return json(200, { messages: [{ id: "late-1" }, { id: "late-2" }] });
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
      resetAccessTokenCacheForTests();
      duringList = async () => {};
      listStatus = 200;
    });

    function gmail() {
      return new GmailAdapter({
        clientId: "test-client-id.apps.googleusercontent.com",
        clientSecret: "test-client-secret",
        redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
        tokenUrl: `${base}/token`,
        gmailApiBaseUrl: `${base}/gmail/v1`,
      });
    }

    async function setup() {
      const { store, vault } = await backend.make();
      await liveGrant(store, vault, "grant_1", "anon_1");
      // The sync holds the grant as it was loaded, before the retirement.
      const loaded = (await store.getGrant("grant_1"))!;
      duringList = async () => {
        const b = await liveGrant(store, vault, "grant_2", "google:1");
        await replaceEarlierGrants({ store, vault, grant: b });
      };
      return { store, vault, loaded };
    }

    it("a 401 after retirement keeps the grant revoked with replacedBy", async () => {
      const { store, vault, loaded } = await setup();
      listStatus = 401;
      // The token is fetched before the list call, so the sync gets that far.
      const result = await syncGmailGrant({ store, vault, gmail: gmail(), grant: loaded, forceBootstrap: true });
      assert.equal(result.error, "needs_reauth", "Gmail refused the token mid-sync");

      const old = await store.getGrant("grant_1");
      assert.equal(old?.status, "revoked", "not moved back to needs_reauth");
      assert.equal(old?.replacedBy, "grant_2", "replacedBy not cleared");
      const live = await store.findLiveGrantsByAddress("default", "gmail", ADDRESS);
      assert.deepEqual(live.map((g) => g.id), ["grant_2"]);
      assert.equal(await markNeedsReauth(store, loaded), false, "direct call is a no-op too");
      assert.equal((await store.getGrant("grant_1"))?.status, "revoked");
    });

    it("messages fetched after retirement are not cached on the retired grant", async () => {
      const { store, vault, loaded } = await setup();
      const result = await syncGmailGrant({ store, vault, gmail: gmail(), grant: loaded, forceBootstrap: true });
      assert.equal(result.status, "ok");
      assert.deepEqual(await store.listMessageIds("grant_1"), [], "no rows on a revoked grant");
      assert.equal((await store.getGrant("grant_1"))?.status, "revoked");

      // The live grant still caches normally.
      await store.upsertMessages([cached("grant_2", 1)]);
      assert.deepEqual(await store.listMessageIds("grant_2"), ["p1"]);
    });

    it("needs_reauth still applies to a grant that was not retired", async () => {
      const { store, vault } = await backend.make();
      await liveGrant(store, vault, "grant_1", "anon_1");
      const loaded = (await store.getGrant("grant_1"))!;
      listStatus = 401;
      const result = await syncGmailGrant({ store, vault, gmail: gmail(), grant: loaded, forceBootstrap: true });
      assert.equal(result.status, "needs_reauth");
      assert.equal((await store.getGrant("grant_1"))?.status, "needs_reauth");
    });
  });
}
