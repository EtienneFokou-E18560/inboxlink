/**
 * Issue #100: a stored message is keyed per grant. The same mailbox connected by
 * two grants (two tenants, or a grant the replace/reuse rule did not retire) holds
 * the same Gmail message ids; each grant must sync and keep its own copy. A failed
 * store write is reported as a store error, never as `gmail_unavailable`.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant, Message } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { drainSyncJobs } from "./queue/sync-queue.js";
import { createApp } from "./routes/app.js";
import { syncGmailGrant } from "./sync/gmail-sync.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const REFRESH = "1//vaulted-refresh-for-issue-100";
const ACCESS = "ya29.issue-100-access-token";
const MASTER = "test-master-key-for-issue-100";
const ADDRESS = "sam.rivera@example.com";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const now = () => NOW;

/** Fake Gmail: one mailbox, whatever grant asks. */
let inbox: string[] = [];
let historyPages: Array<{ history?: unknown[]; historyId: string }> = [];
let profileHistoryId = "500";
let google: Server;
let tokenUrl = "";
let gmailApiBaseUrl = "";

function resource(id: string) {
  if (!inbox.includes(id)) return undefined;
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: `Snippet ${id}`,
    internalDate: String(NOW - DAY),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Lee Ortega <lee.ortega@example.com>" },
        { name: "To", value: ADDRESS },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { data: Buffer.from("Body").toString("base64url") },
    },
  };
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
    req.on("error", reject);
  });
}

before(async () => {
  google = createServer(async (req, res) => {
    const url = req.url ?? "/";
    await drain(req);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/token")) return json(200, { access_token: ACCESS, expires_in: 3600 });
    if (url.startsWith("/gmail/v1/users/me/profile")) {
      return json(200, { emailAddress: ADDRESS, historyId: profileHistoryId });
    }
    if (url.startsWith("/gmail/v1/users/me/history")) {
      return json(200, historyPages[0] ?? { history: [], historyId: profileHistoryId });
    }
    if (url.startsWith("/gmail/v1/users/me/messages/")) {
      const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
      const body = resource(id);
      return body ? json(200, body) : json(404, { error: { code: 404 } });
    }
    if (url.startsWith("/gmail/v1/users/me/messages")) {
      return json(200, { messages: inbox.map((id) => ({ id })) });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const port = (google.address() as { port: number }).port;
  tokenUrl = `http://127.0.0.1:${port}/token`;
  gmailApiBaseUrl = `http://127.0.0.1:${port}/gmail/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => google.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetAccessTokenCacheForTests();
  inbox = [];
  historyPages = [];
  profileHistoryId = "500";
});

function gmail() {
  return new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
    tokenUrl,
    gmailApiBaseUrl,
  });
}

function grantFor(id: string, tenantId: string): Grant {
  const at = new Date(NOW - DAY).toISOString();
  return {
    id,
    tenantId,
    externalUserId: `user_${tenantId}`,
    provider: "gmail",
    email: ADDRESS,
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: at,
    updatedAt: at,
  };
}

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}
  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(text, params)).rows ?? [];
  }
  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

function pgSetup(pglite = new PGlite()) {
  const db = new PgDatabase(new PgliteExecutor(pglite));
  return { pglite, db, store: new PostgresStore(db, { masterKey: MASTER }), vault: new PostgresTokenVault(db, MASTER) };
}

async function addTenants(pglite: PGlite, db: PgDatabase): Promise<void> {
  await db.ensure();
  await pglite.query(
    `INSERT INTO tenants (id, name, api_secret_hash) VALUES
       ('tenant_north', 'North', 'x'), ('tenant_south', 'South', 'x')
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function connect(
  store: MemoryStore | PostgresStore,
  vault: MemoryTokenVault | PostgresTokenVault,
  id: string,
  tenantId: string,
): Promise<Grant> {
  const grant = grantFor(id, tenantId);
  await store.putGrant(grant);
  await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
  return grant;
}

function sync(store: MemoryStore | PostgresStore, vault: MemoryTokenVault | PostgresTokenVault, grant: Grant) {
  return syncGmailGrant({ store, vault, gmail: gmail(), grant, now });
}

async function stored(store: PostgresStore, grantId: string): Promise<Message[]> {
  return (await store.listMessagesPage(grantId, { offset: 0, limit: 50 })).messages;
}

describe("issue #100: the same Gmail message under two grants", () => {
  it("both grants sync ok and each lists its own copy (first look, then new mail)", async () => {
    const { pglite, db, store, vault } = pgSetup();
    await addTenants(pglite, db);
    inbox = ["shared-1"];
    const alpha = await connect(store, vault, "grant_alpha", "tenant_north");
    const beta = await connect(store, vault, "grant_beta", "tenant_south");

    const first = await sync(store, vault, alpha);
    assert.equal(first.status, "ok");
    assert.equal(first.upserted, 1);
    const second = await sync(store, vault, beta);
    assert.equal(second.status, "ok", `grant_beta: ${second.error ?? ""}`);
    assert.equal(second.upserted, 1);

    // New mail reaches both grants through history (the incremental path).
    inbox = ["shared-1", "shared-2"];
    historyPages = [
      {
        historyId: "600",
        history: [{ id: "501", messagesAdded: [{ message: { id: "shared-2", labelIds: ["INBOX"] } }] }],
      },
    ];
    for (const grant of [alpha, beta]) {
      const result = await sync(store, vault, grant);
      assert.equal(result.status, "ok", `${grant.id}: ${result.error ?? ""}`);
      assert.equal(result.mode, "incremental");
      assert.equal(result.upserted, 1);
    }

    for (const grant of [alpha, beta]) {
      const rows = await stored(store, grant.id);
      assert.deepEqual(rows.map((m) => m.providerMessageId).sort(), ["shared-1", "shared-2"]);
      assert.ok(rows.every((m) => m.grantId === grant.id));
      // The id format is unchanged: msg_<gmailId>, the same under both grants.
      assert.deepEqual(rows.map((m) => m.id).sort(), ["msg_shared-1", "msg_shared-2"]);
      assert.ok(rows.some((m) => m.subject === "Subject shared-1"), "each copy decrypts under its own grant");
    }
    const count = await pglite.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages`);
    assert.equal(count.rows[0]!.n, 4);

    // Deleting one grant's copy leaves the other grant's copy alone.
    await store.deleteMessagesByProviderIds(alpha.id, ["shared-1"]);
    assert.deepEqual((await stored(store, alpha.id)).map((m) => m.providerMessageId), ["shared-2"]);
    assert.equal((await stored(store, beta.id)).length, 2);
  });

  it("a queued sync job for the second grant completes", async () => {
    const { pglite, db, store, vault } = pgSetup();
    await addTenants(pglite, db);
    inbox = ["shared-1"];
    const alpha = await connect(store, vault, "grant_alpha", "tenant_north");
    const beta = await connect(store, vault, "grant_beta", "tenant_south");
    assert.equal((await sync(store, vault, alpha)).status, "ok");

    const job = await store.enqueueSyncJob({ grantId: beta.id, tenantId: beta.tenantId, kind: "full" });
    const summary = await drainSyncJobs({ store, vault, gmail: gmail(), now });
    assert.equal(summary.completed, 1);
    const finished = await store.getSyncJob(job.id);
    assert.equal(finished?.status, "completed", finished?.error ?? "");
    assert.equal((await stored(store, beta.id)).length, 1);
  });
});

describe("issue #100: a store write failure is a store error", () => {
  class FailingStore extends MemoryStore {
    override async upsertMessages(): Promise<void> {
      throw new Error('duplicate key value violates unique constraint "messages_pkey"');
    }
  }

  it("reports store_unavailable, not gmail_unavailable, and the job fails with that code", async () => {
    const store = new FailingStore();
    const vault = new MemoryTokenVault(MASTER);
    inbox = ["shared-1"];
    const grant = await connect(store, vault, "grant_alpha", "tenant_north");

    const result = await sync(store, vault, grant);
    assert.notEqual(result.status, "gmail_unavailable");
    assert.equal(result.status, "store_unavailable");
    assert.equal(result.error, "store_unavailable");
    assert.equal(result.upserted, 0);
    // The grant stays active: nothing is wrong with Google.
    assert.equal((await store.getGrant(grant.id))?.status, "active");

    const job = await store.enqueueSyncJob({ grantId: grant.id, tenantId: grant.tenantId, kind: "full" });
    await drainSyncJobs({ store, vault, gmail: gmail(), now });
    assert.equal((await store.getSyncJob(job.id))?.error, "store_unavailable");
  });

  it("a Gmail failure is still gmail_unavailable", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = await connect(store, vault, "grant_beta", "tenant_south");
    const broken = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
      tokenUrl,
      gmailApiBaseUrl: `${gmailApiBaseUrl}/missing-prefix-500`,
    });
    // An unknown path answers 404 on list, which the bootstrap does not treat as a reconnect.
    const result = await syncGmailGrant({ store, vault, gmail: broken, grant, now });
    assert.equal(result.status, "gmail_unavailable");
  });
});

describe("issue #100: startup DDL on a database created before the change", () => {
  /** The tables as main created them before #100: `messages.id` alone is the primary key. */
  const OLD_SCHEMA = `
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_secret_hash TEXT NOT NULL, webhook_secret TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE grants (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), external_user_id TEXT NOT NULL, provider TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, scopes JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), replaced_by TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, provider_message_id TEXT NOT NULL, thread_id TEXT, subject TEXT NOT NULL, snippet TEXT NOT NULL, payload JSONB, received_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), labels JSONB, subject_ct BYTEA, snippet_ct BYTEA, UNIQUE (grant_id, provider_message_id));
    CREATE INDEX messages_grant_received_idx ON messages (grant_id, received_at DESC);
    INSERT INTO tenants (id, name, api_secret_hash) VALUES ('tenant_north', 'North', 'x'), ('tenant_south', 'South', 'x');
    INSERT INTO grants (id, tenant_id, external_user_id, provider, email, status, scopes)
      VALUES ('grant_alpha', 'tenant_north', 'user_tenant_north', 'gmail', '${ADDRESS}', 'active', '[]');
    INSERT INTO messages (id, grant_id, provider_message_id, thread_id, subject, snippet, payload, received_at)
      VALUES
        ('msg_shared-1', 'grant_alpha', 'shared-1', 't-shared-1', 'Old subject', 'Old snippet',
         '{"id":"msg_shared-1","grantId":"grant_alpha","providerMessageId":"shared-1","subject":"Old subject","snippet":"Old snippet","from":[],"to":[],"sentAt":"2026-10-23T12:00:00.000Z","receivedAt":"2026-10-23T12:00:00.000Z","folderIds":["INBOX"],"labels":["INBOX"],"hasAttachments":false}',
         '2026-10-23T12:00:00.000Z'),
        ('msg_old-2', 'grant_alpha', 'old-2', 't-old-2', 'Second old', 'Old snippet 2', NULL, '2026-10-22T12:00:00.000Z');
  `;

  async function primaryKey(pglite: PGlite): Promise<{ name: string; columns: string[] } | undefined> {
    const rows = (
      await pglite.query<{ conname: string; columns: string[] }>(
        `SELECT c.conname, array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE c.conrelid = 'messages'::regclass AND c.contype = 'p'
         GROUP BY c.conname`,
      )
    ).rows;
    return rows[0] ? { name: rows[0].conname, columns: rows[0].columns } : undefined;
  }

  async function messageIndexes(pglite: PGlite): Promise<string[]> {
    return (
      await pglite.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' ORDER BY indexname`,
      )
    ).rows.map((r) => r.indexname);
  }

  it("runs twice cleanly, keeps old rows readable, then lets a second grant store the same message", async () => {
    const pglite = new PGlite();
    await pglite.exec(OLD_SCHEMA);
    assert.deepEqual(await primaryKey(pglite), { name: "messages_pkey", columns: ["id"] });
    const before = (await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows;

    // Two cold starts one after the other, then two at once.
    await pgSetup(pglite).db.ensure();
    const afterFirst = await messageIndexes(pglite);
    await pgSetup(pglite).db.ensure();
    await Promise.all([pgSetup(pglite).db.ensure(), pgSetup(pglite).db.ensure()]);

    assert.deepEqual(await primaryKey(pglite), { name: "messages_grant_pkey", columns: ["grant_id", "id"] });
    assert.deepEqual(await messageIndexes(pglite), afterFirst, "later starts add no index");
    assert.ok(!afterFirst.includes("messages_pkey"));
    assert.deepEqual((await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows, before, "rows untouched");

    // Old rows read back with the ids hosts already hold.
    const { store, vault } = pgSetup(pglite);
    const rows = await stored(store, "grant_alpha");
    assert.deepEqual(rows.map((m) => m.id).sort(), ["msg_old-2", "msg_shared-1"]);
    assert.ok(rows.some((m) => m.subject === "Old subject"));

    // The second grant for the same mailbox now stores its own copy of shared-1.
    await vault.seal(REFRESH, { grantId: "grant_alpha", tenantId: "tenant_north" });
    const beta = await connect(store, vault, "grant_beta", "tenant_south");
    inbox = ["shared-1"];
    const result = await sync(store, vault, beta);
    assert.equal(result.status, "ok", result.error ?? "");
    assert.deepEqual((await stored(store, beta.id)).map((m) => m.id), ["msg_shared-1"]);
    assert.equal((await stored(store, "grant_alpha")).length, 2);
  });

  it("a fresh database gets the per-grant key straight away and a second start changes nothing", async () => {
    const pglite = new PGlite();
    await pgSetup(pglite).db.ensure();
    assert.deepEqual(await primaryKey(pglite), { name: "messages_grant_pkey", columns: ["grant_id", "id"] });
    const indexes = await messageIndexes(pglite);
    await pgSetup(pglite).db.ensure();
    assert.deepEqual(await messageIndexes(pglite), indexes);
  });

  it("a start that cannot read the catalog runs every statement and still succeeds (old, then upgraded DB)", async () => {
    /** The catalog read fails, so nothing is skipped: the path a start with a stale catalog takes. */
    class NoCatalogExecutor extends PgliteExecutor {
      override async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
        if (/information_schema\.columns/.test(text)) throw new Error("catalog unavailable");
        return super.query<T>(text, params);
      }
    }
    const pglite = new PGlite();
    await pglite.exec(OLD_SCHEMA);
    const before = (await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows;
    await new PgDatabase(new NoCatalogExecutor(pglite)).ensure();
    assert.deepEqual(await primaryKey(pglite), { name: "messages_grant_pkey", columns: ["grant_id", "id"] });
    // Second start without a catalog: the key swap is already done and must not fail.
    await new PgDatabase(new NoCatalogExecutor(pglite)).ensure();
    assert.deepEqual(await primaryKey(pglite), { name: "messages_grant_pkey", columns: ["grant_id", "id"] });
    assert.deepEqual((await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows, before);
  });

  it("messages.get by InboxLink id still answers for the grant that asks", async () => {
    const { pglite, db, store, vault } = pgSetup();
    await addTenants(pglite, db);
    inbox = ["shared-1"];
    const grant = await connect(store, vault, "grant_alpha", "default");
    await sync(store, vault, grant);
    const app = createApp({
      store,
      vault,
      gmail: gmail(),
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      queue: null,
      rateLimiter: null,
    });
    const res = await app.request(`/v1/grants/${grant.id}/messages/msg_shared-1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { message: { id: string; grantId: string } };
    assert.equal(body.message.id, "msg_shared-1");
    assert.equal(body.message.grantId, grant.id);
  });
});
