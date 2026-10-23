import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { unescapeHtml } from "@inboxlink/connect-ui";
import type { Grant, Message, TokenVault } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { connectGrant, parseConnectPolicies, pickReuseTarget } from "./connect-grant.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { markNeedsReauth, type CiphertextVault } from "./gmail-access.js";
import type { SyncJob } from "./queue/sync-queue.js";
import { createApp } from "./routes/app.js";
import { MemoryStore, type GrantStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import type { WebhookEventType } from "./webhooks/deliver.js";

const MASTER = "test-master-key-at-least-16";
const ADDRESS = "owner@gmail.com";
const SECRETS = { askel: "askel-secret", beta: "beta-secret", plain: "plain-secret" } as const;
type Tenant = keyof typeof SECRETS;

/** The address Google reports on the next Connect. */
let googleEmail = ADDRESS;
/** The mailbox Gmail's profile reports; undefined: the same as googleEmail. 0: the profile call fails. */
let gmailProfile: string | 0 | undefined;
/** Google's answer to a token refresh: [status, body]. */
let refreshAnswer: [number, unknown] = [200, { access_token: "ya29.refreshed", expires_in: 3600 }];
/** Gmail's answer to a live messages list: [status, body]. */
let listAnswer: [number, unknown] = [200, { messages: [] }];
/** Each Connect gets its own refresh token, so a test can tell which one is sealed. */
let refreshCounter = 0;

let google: Server;
let tokenUrl = "";
let userinfoUrl = "";
let gmailApiBaseUrl = "";

before(async () => {
  google = createServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => resolve(text));
    });
    if (req.url?.startsWith("/token") && body.includes("grant_type=refresh_token")) {
      res.writeHead(refreshAnswer[0], { "content-type": "application/json" });
      res.end(JSON.stringify(refreshAnswer[1]));
      return;
    }
    if (req.url?.startsWith("/gmail/v1/users/me/messages")) {
      res.writeHead(listAnswer[0], { "content-type": "application/json" });
      res.end(JSON.stringify(listAnswer[1]));
      return;
    }
    if (req.url?.startsWith("/token")) {
      refreshCounter += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "ya29.test-access",
          refresh_token: `1//refresh-${refreshCounter}`,
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/userinfo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: googleEmail }));
      return;
    }
    if (req.url?.startsWith("/gmail/v1/users/me/profile")) {
      if (gmailProfile === 0) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 503 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ emailAddress: gmailProfile ?? googleEmail, historyId: "1" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const port = (google.address() as { port: number }).port;
  tokenUrl = `http://127.0.0.1:${port}/token`;
  userinfoUrl = `http://127.0.0.1:${port}/userinfo`;
  gmailApiBaseUrl = `http://127.0.0.1:${port}/gmail/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => google.close(() => resolve()));
});

beforeEach(() => {
  googleEmail = ADDRESS;
  gmailProfile = undefined;
  refreshAnswer = [200, { access_token: "ya29.refreshed", expires_in: 3600 }];
  listAnswer = [200, { messages: [] }];
  resetAccessTokenCacheForTests();
});

type Event = { type: WebhookEventType; data: Record<string, unknown> };

function buildApp(policy = "askel=reuse beta=reuse") {
  const store = new MemoryStore();
  const vault = new MemoryTokenVault(MASTER);
  const events: Event[] = [];
  const jobs: SyncJob[] = [];
  const app = createApp({
    store,
    vault,
    gmail: new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
      tokenUrl,
      userinfoUrl,
      gmailApiBaseUrl,
    }),
    publicBaseUrl: "http://localhost:8787",
    apiSecret: SECRETS.askel,
    tenantId: "askel",
    tenantSecrets: { ...SECRETS },
    mode: "multi",
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
    queue: {
      async enqueue(job) {
        jobs.push(job);
        return { jobId: `job_${jobs.length}` };
      },
      async close() {},
    },
    rateLimiter: null,
    connectPolicies: parseConnectPolicies(policy),
    webhooks: {
      enabled: true,
      async emit(type, data) {
        events.push({ type, data });
        return { ok: true, attempts: 1, dropped: false };
      },
    },
  });
  return { app, store, vault, events, jobs };
}

type Built = ReturnType<typeof buildApp>;

function auth(tenant: Tenant) {
  return { authorization: `Bearer ${SECRETS[tenant]}`, "content-type": "application/json" };
}

/** Start Connect for a host user and return the OAuth state Google would send back. */
async function startConnect(
  built: Built,
  externalUserId: string,
  opts: { tenant?: Tenant; replacesGrantId?: string } = {},
): Promise<string> {
  const tenant = opts.tenant ?? "askel";
  const created = await built.app.request("/v1/link/sessions", {
    method: "POST",
    headers: auth(tenant),
    body: JSON.stringify({
      externalUserId,
      redirectUri: "http://localhost:9999/done",
      ...(opts.replacesGrantId ? { replacesGrantId: opts.replacesGrantId } : {}),
    }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { linkToken } = (await created.json()) as { linkToken: string };
  const page = await (await built.app.request(`/v1/connect/${encodeURIComponent(linkToken)}`)).text();
  const href = unescapeHtml(page.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "");
  return new URL(href).searchParams.get("state") ?? "";
}

/** Google redirects back; returns the exchanged grant id. */
async function finishConnect(built: Built, state: string, tenant: Tenant = "askel"): Promise<string> {
  const callback = await built.app.request(
    `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
  );
  assert.equal(callback.status, 302);
  const publicToken = new URL(callback.headers.get("location") ?? "").searchParams.get("public_token");
  const exchanged = await built.app.request("/v1/grants/exchange", {
    method: "POST",
    headers: auth(tenant),
    body: JSON.stringify({ publicToken }),
  });
  assert.equal(exchanged.status, 200);
  return ((await exchanged.json()) as { grantId: string }).grantId;
}

async function connectAs(
  built: Built,
  externalUserId: string,
  opts: { tenant?: Tenant; replacesGrantId?: string } = {},
): Promise<string> {
  return finishConnect(built, await startConnect(built, externalUserId, opts), opts.tenant ?? "askel");
}

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

async function sealedToken(vault: MemoryTokenVault, grant: Grant): Promise<string | undefined> {
  const ciphertext = await vault.getCiphertext(grant.id);
  if (!ciphertext) return undefined;
  return vault.open(ciphertext, { grantId: grant.id, tenantId: grant.tenantId });
}

describe("Connect rule `reuse` (askel#604): same address", () => {
  it("connecting the same address twice keeps the grant id, the cache, and seals the fresh token", async () => {
    const built = buildApp();
    const { store, vault, jobs } = built;
    const first = await connectAs(built, "google:1");
    await store.upsertMessages([cached(first, 1), cached(first, 2)]);
    store.grants.get(first)!.status = "needs_reauth"; // Google refused the old token

    googleEmail = "Owner@Gmail.com"; // casing differs between consents
    const second = await connectAs(built, "google:1");

    assert.equal(second, first, "same grantId");
    const grant = store.grants.get(first)!;
    assert.equal(grant.status, "active");
    assert.equal(grant.externalUserId, "google:1");
    assert.equal(grant.replacedBy, undefined);
    assert.equal(store.grants.size, 1, "no second grant was made");
    assert.deepEqual(await store.listMessageIds(first), ["p1", "p2"], "the cache is kept");
    assert.equal(await sealedToken(vault, grant), `1//refresh-${refreshCounter}`, "the fresh token is sealed");
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.forceBootstrap]),
      [
        ["bootstrap", true],
        ["incremental", false],
      ],
      "a reused grant only catches up; nothing is fetched twice",
    );
  });

  it("a second host user taking the same address gets the same grant; reads naming the first get 409 grant_replaced", async () => {
    const built = buildApp();
    const { app, store, events } = built;
    const anon = await connectAs(built, "anon_7f3c");
    await store.upsertMessages([cached(anon, 1)]);
    events.length = 0;

    const signedIn = await connectAs(built, "google:1077");
    assert.equal(signedIn, anon, "same grantId");
    assert.equal(store.grants.get(anon)?.externalUserId, "google:1077", "the new identity owns it now");

    const h = auth("askel");
    for (const [method, path] of [
      ["GET", `/v1/grants/${anon}/messages?externalUserId=anon_7f3c`],
      ["GET", `/v1/grants/${anon}/messages/p1?externalUserId=anon_7f3c`],
      ["POST", `/v1/grants/${anon}/sync?externalUserId=anon_7f3c`],
      ["GET", `/v1/grants/${anon}/sync/jobs/job_1?externalUserId=anon_7f3c`],
      ["DELETE", `/v1/grants/${anon}?externalUserId=anon_7f3c`],
    ] as const) {
      const res = await app.request(path, { method, headers: h });
      assert.equal(res.status, 409, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "grant_replaced" });
    }
    assert.equal(store.grants.get(anon)?.status, "active", "the old identity's delete did not touch it");

    const ownRead = await app.request(`/v1/grants/${anon}/messages?externalUserId=google%3A1077`, { headers: h });
    assert.equal(ownRead.status, 200);
    assert.equal(((await ownRead.json()) as { messages: unknown[] }).messages.length, 1, "cache kept for the new owner");
    const unnamed = await app.request(`/v1/grants/${anon}/messages`, { headers: h });
    assert.equal(unnamed.status, 200, "hosts that never name a user keep today's behaviour");
    const bad = await app.request(`/v1/grants/${anon}/messages?externalUserId=`, { headers: h });
    assert.equal(bad.status, 400);

    const oldList = (await (await app.request("/v1/grants?externalUserId=anon_7f3c", { headers: h })).json()) as {
      grants: unknown[];
    };
    assert.deepEqual(oldList.grants, [], "the grant is no longer listed for the old identity");

    assert.deepEqual(
      events.map((e) => [e.type, e.data.grantId, e.data.externalUserId, e.data.reason ?? e.data.reused]),
      [
        ["grant.connected", anon, "google:1077", true],
        ["grant.revoked", anon, "anon_7f3c", "reassigned"],
      ],
    );
  });

  it("several live grants for the address: the user's own is reused and the others retired", async () => {
    // Left over from before one-grant-per-address, or made under `replace`.
    const built = buildApp();
    const { store, vault } = built;
    const mine = await connectAs(built, "google:1");
    const other = "grant_dup";
    store.grants.set(other, { ...store.grants.get(mine)!, id: other, externalUserId: "anon_1", createdAt: "2026-10-22T00:00:00.000Z" });
    await vault.seal("1//dup", { grantId: other, tenantId: "askel" });
    await store.upsertMessages([cached(other, 9)]);

    assert.equal(await connectAs(built, "google:1"), mine);
    assert.equal(store.grants.get(other)?.status, "revoked");
    assert.equal(store.grants.get(other)?.replacedBy, mine);
    assert.equal(await vault.getCiphertext(other), undefined);
    assert.deepEqual(await store.listMessageIds(other), []);
    const live = await store.findLiveGrantsByAddress("askel", "gmail", ADDRESS);
    assert.deepEqual(live.map((g) => g.id), [mine]);
  });
});

describe("Connect rule `reuse`: only a confirmed mailbox address is reused", () => {
  it("a token whose Gmail mailbox differs from the id-token address never takes over a grant", async () => {
    const built = buildApp();
    const { store, vault } = built;
    const victim = await connectAs(built, "google:victim");
    await store.upsertMessages([cached(victim, 1)]);
    const victimToken = await sealedToken(vault, store.grants.get(victim)!);

    // The account claims the victim's address, but its mailbox is another one.
    gmailProfile = "attacker@gmail.com";
    const attacker = await connectAs(built, "google:attacker");

    assert.notEqual(attacker, victim, "a new grant, not the victim's");
    assert.equal(store.grants.get(victim)?.externalUserId, "google:victim");
    assert.equal(await sealedToken(vault, store.grants.get(victim)!), victimToken, "the victim's token is untouched");
    assert.deepEqual(await store.listMessageIds(attacker), [], "no cache handed over");
    assert.equal(store.grants.get(attacker)?.email, "attacker@gmail.com", "filed under the mailbox it really is");
    assert.equal(store.grants.get(victim)?.status, "active", "and the victim's grant is not retired");
  });

  it("when Gmail's profile cannot be read, a new grant is made rather than reusing on an unconfirmed address", async () => {
    const built = buildApp();
    const first = await connectAs(built, "google:1");
    gmailProfile = 0;
    const second = await connectAs(built, "google:1");
    assert.notEqual(second, first);
  });

  it("Microsoft grants are never reused", async () => {
    const { store, vault } = await BACKENDS[0]!.make();
    await store.putGrant({ ...row("grant_ms", "askel", "u1", "2026-10-01T00:00:00.000Z"), provider: "microsoft" });
    const out = await connectGrant({
      store,
      vault,
      policy: "reuse",
      tenantId: "askel",
      externalUserId: "u2",
      provider: "microsoft",
      email: ADDRESS,
      verifiedAddress: ADDRESS,
      fallbackEmail: "unknown@outlook.com",
      refreshToken: "r",
      scopes: [],
      createdAt: () => "2026-10-23T00:00:00.000Z",
      newGrantId: () => "grant_ms_new",
    });
    assert.equal(out.reused, false);
    assert.equal(out.grant.id, "grant_ms_new");
  });
});

describe("a failure from before a reconnect does not touch the reused grant", () => {
  it("markNeedsReauth with the old snapshot leaves the reused grant active and its owner as set", async () => {
    for (const backend of BACKENDS) {
      const { store, vault } = await backend.make();
      await store.putGrant(row("grant_1", "askel", "anon_1", "2026-10-01T00:00:00.000Z"));
      await vault.seal("1//old", { grantId: "grant_1", tenantId: "askel" });
      const stale = (await store.getGrant("grant_1"))!; // a sync loaded it
      const out = await connectGrant({
        store,
        vault,
        policy: "reuse",
        tenantId: "askel",
        externalUserId: "google:1",
        provider: "gmail",
        email: ADDRESS,
        verifiedAddress: ADDRESS,
        fallbackEmail: "unknown@gmail.com",
        refreshToken: "1//new",
        scopes: ["s"],
        createdAt: () => "2026-10-23T00:00:00.000Z",
        newGrantId: () => "grant_new",
      });
      assert.equal(out.reused, true);
      // ...then the old token is refused and the stale sync marks it.
      assert.equal(await markNeedsReauth(store, stale), false, backend.name);
      const now = await store.getGrant("grant_1");
      assert.equal(now?.status, "active", backend.name);
      assert.equal(now?.externalUserId, "google:1", `${backend.name}: the owner is not written back`);
      // A failure of the current version still marks it.
      assert.equal(await markNeedsReauth(store, now!), true, backend.name);
      assert.equal((await store.getGrant("grant_1"))?.status, "needs_reauth");
    }
  });
});

describe("Connect rule `reuse`: different address", () => {
  it("replaces the named grant when the host says the person chose replace", async () => {
    const built = buildApp();
    const { store, vault, events } = built;
    const old = await connectAs(built, "google:1");
    await store.upsertMessages([cached(old, 1)]);
    events.length = 0;

    googleEmail = "second@gmail.com";
    const fresh = await connectAs(built, "google:1", { replacesGrantId: old });

    assert.notEqual(fresh, old);
    assert.equal(store.grants.get(fresh)?.status, "active");
    assert.equal(store.grants.get(old)?.status, "revoked");
    assert.equal(store.grants.get(old)?.replacedBy, fresh);
    assert.equal(await vault.getCiphertext(old), undefined, "old token gone");
    assert.deepEqual(await store.listMessageIds(old), [], "old cache gone");
    assert.deepEqual(
      events.map((e) => [e.type, e.data.grantId, e.data.reason ?? e.data.reused]),
      [
        ["grant.connected", fresh, false],
        ["grant.revoked", old, "replaced"],
      ],
    );
  });

  it("adds the mailbox next to the existing one when the host names nothing (the person chose add)", async () => {
    const built = buildApp();
    const { store } = built;
    const first = await connectAs(built, "google:1");
    googleEmail = "second@gmail.com";
    const second = await connectAs(built, "google:1");
    assert.notEqual(second, first);
    assert.equal(store.grants.get(first)?.status, "active");
    assert.equal(store.grants.get(second)?.status, "active");
  });

  it("a same-address Connect naming the grant reuses it rather than replacing it", async () => {
    const built = buildApp();
    const first = await connectAs(built, "google:1");
    assert.equal(await connectAs(built, "google:1", { replacesGrantId: first }), first);
    assert.equal(built.store.grants.get(first)?.status, "active");
  });

  it("refuses a replacesGrantId that is not the host user's own live grant in this tenant", async () => {
    const built = buildApp();
    const mine = await connectAs(built, "google:1");
    built.store.grants.set("grant_dead", { ...built.store.grants.get(mine)!, id: "grant_dead", status: "revoked" });
    for (const [tenant, user, id] of [
      ["askel", "google:1", "grant_dead"], // already revoked
      ["askel", "google:2", mine], // another user's grant
      ["beta", "google:1", mine], // another tenant's grant
      ["askel", "google:1", "grant_nope"],
    ] as const) {
      const res = await built.app.request("/v1/link/sessions", {
        method: "POST",
        headers: auth(tenant),
        body: JSON.stringify({ externalUserId: user, redirectUri: "http://localhost:9999/done", replacesGrantId: id }),
      });
      assert.equal(res.status, 400, `${tenant} ${user} ${id}`);
      assert.deepEqual(await res.json(), { error: "invalid_replaces_grant" });
    }
  });

  it("does not retire a named grant that moved to another user before the Connect finished", async () => {
    const built = buildApp();
    const { store } = built;
    const mine = await connectAs(built, "google:1");
    googleEmail = "second@gmail.com";
    const state = await startConnect(built, "google:1", { replacesGrantId: mine });
    store.grants.get(mine)!.externalUserId = "google:2"; // reassigned meanwhile
    const fresh = await finishConnect(built, state);
    assert.notEqual(fresh, mine);
    assert.equal(store.grants.get(mine)?.status, "active", "another user's grant is never retired");
  });
});

describe("Connect rule per tenant", () => {
  it("a tenant without the setting keeps replace: a new grant, the old one retired, and the host is told", async () => {
    const built = buildApp();
    const { store, events, jobs } = built;
    const first = await connectAs(built, "u1", { tenant: "plain" });
    events.length = 0;
    const second = await connectAs(built, "u2", { tenant: "plain" });
    assert.notEqual(second, first);
    assert.equal(store.grants.get(first)?.status, "revoked");
    assert.equal(store.grants.get(first)?.replacedBy, second);
    assert.deepEqual(jobs.map((j) => j.kind), ["bootstrap", "bootstrap"], "job kinds as before");
    // New in 0.2.0 for every tenant: the user who lost the mailbox is named.
    assert.deepEqual(
      events.map((e) => [e.type, e.data.grantId, e.data.externalUserId, e.data.reason ?? e.data.reused]),
      [
        ["grant.connected", second, "u2", false],
        ["grant.revoked", first, "u1", "replaced"],
      ],
    );
  });

  it("nothing is shared across tenants: each keeps its own grant for the same address", async () => {
    const built = buildApp();
    const { app, store } = built;
    const a = await connectAs(built, "google:1", { tenant: "askel" });
    await store.upsertMessages([cached(a, 1)]);
    const b = await connectAs(built, "google:1", { tenant: "beta" });
    const a2 = await connectAs(built, "google:2", { tenant: "askel" });

    assert.notEqual(b, a, "beta's Connect does not reuse askel's grant");
    assert.equal(a2, a);
    assert.equal(store.grants.get(a)?.tenantId, "askel");
    assert.equal(store.grants.get(b)?.tenantId, "beta");
    assert.equal(store.grants.get(a)?.status, "active");
    assert.equal(store.grants.get(b)?.status, "active");
    assert.deepEqual(await store.listMessageIds(b), [], "beta does not see askel's cache");

    const foreign = await app.request(`/v1/grants/${a}/messages`, { headers: auth("beta") });
    assert.equal(foreign.status, 404);
    const foreignReplace = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: auth("beta"),
      body: JSON.stringify({ externalUserId: "google:2", redirectUri: "http://localhost:9999/done", replacesGrantId: a }),
    });
    assert.equal(foreignReplace.status, 400);
  });

  it("rejects a malformed INBOXLINK_CONNECT_POLICY", () => {
    assert.deepEqual(parseConnectPolicies(undefined), {});
    assert.deepEqual(parseConnectPolicies(" askel=reuse, beta=replace "), { askel: "reuse", beta: "replace" });
    for (const bad of ["askel", "askel=keep", "=reuse"]) {
      assert.throws(() => parseConnectPolicies(bad), /INBOXLINK_CONNECT_POLICY/);
    }
  });
});

describe("concurrent Connects for one address under `reuse`", () => {
  it("two Connects finishing together with an existing grant both land on it", async () => {
    const built = buildApp();
    const { store } = built;
    const existing = await connectAs(built, "google:1");
    const [s1, s2] = [await startConnect(built, "google:1"), await startConnect(built, "anon_9")];
    const [g1, g2] = await Promise.all([finishConnect(built, s1), finishConnect(built, s2)]);
    assert.equal(g1, existing);
    assert.equal(g2, existing);
    const live = await store.findLiveGrantsByAddress("askel", "gmail", ADDRESS);
    assert.deepEqual(live.map((g) => g.id), [existing], "exactly one live grant");
  });

  it("two first Connects finishing together leave exactly one live grant", async () => {
    const built = buildApp();
    const [s1, s2] = [await startConnect(built, "google:1"), await startConnect(built, "google:1")];
    await Promise.all([finishConnect(built, s1), finishConnect(built, s2)]);
    const live = await built.store.findLiveGrantsByAddress("askel", "gmail", ADDRESS);
    assert.equal(live.length, 1);
  });
});

describe("needs_reauth only when Google requires it, through the HTTP routes", () => {
  async function liveRead(built: Built, grantId: string) {
    return built.app.request(`/v1/grants/${grantId}/messages?source=live`, { headers: auth("askel") });
  }

  it("a refresh Google answers with 500 gives 502 gmail_unavailable; the grant stays active, no webhook", async () => {
    const built = buildApp();
    const g = await connectAs(built, "google:1");
    built.events.length = 0;
    refreshAnswer = [500, { error: "internal_failure" }];
    const res = await liveRead(built, g);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "gmail_unavailable" });
    assert.equal(built.store.grants.get(g)?.status, "active");
    assert.deepEqual(built.events, []);
  });

  it("a refresh refused with invalid_grant gives 409 needs_reauth and tells the host", async () => {
    const built = buildApp();
    const g = await connectAs(built, "google:1");
    built.events.length = 0;
    refreshAnswer = [400, { error: "invalid_grant" }];
    const res = await liveRead(built, g);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "needs_reauth");
    assert.equal(built.store.grants.get(g)?.status, "needs_reauth");
    assert.deepEqual(built.events.map((e) => e.type), ["grant.needs_reauth"]);
  });

  it("a Gmail 403 rate limit is temporary; a 403 for a withdrawn scope asks to reconnect", async () => {
    const built = buildApp();
    const g = await connectAs(built, "google:1");
    listAnswer = [403, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }];
    const limited = await liveRead(built, g);
    assert.equal(limited.status, 502);
    assert.equal(built.store.grants.get(g)?.status, "active");
    listAnswer = [403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }];
    const withdrawn = await liveRead(built, g);
    assert.equal(withdrawn.status, 409);
    assert.equal(built.store.grants.get(g)?.status, "needs_reauth");
  });
});

describe("tenant-wide grant listing (GET /v1/grants?all=true)", () => {
  it("lists only the calling tenant's grants, paged, with no address", async () => {
    const built = buildApp();
    const { app, store } = built;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      googleEmail = `user${i}@gmail.com`;
      ids.push(await connectAs(built, `google:${i}`));
    }
    await connectAs(built, "other", { tenant: "beta" });
    const job = await store.enqueueSyncJob({ grantId: ids[0]!, tenantId: "askel", kind: "incremental" });
    await store.claimQueuedSyncJobs(10);
    await store.completeSyncJob(job.id, { upserted: 0 });

    const seen: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await app.request(`/v1/grants?all=true&limit=2${cursor ? `&cursor=${cursor}` : ""}`, {
        headers: auth("askel"),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { grants: Record<string, unknown>[]; nextCursor?: string };
      seen.push(...body.grants);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);

    assert.equal(pages, 3);
    assert.deepEqual(seen.map((g) => g.id), ids, "oldest first, every grant once");
    assert.equal(JSON.stringify(seen).includes("@"), false, "no address");
    assert.deepEqual(Object.keys(seen[1]!).sort(), ["createdAt", "externalUserId", "id", "provider", "status", "updatedAt"]);
    assert.ok(typeof seen[0]!.lastSyncAt === "string", "last finished sync is shown");

    const beta = (await (await app.request("/v1/grants?all=true", { headers: auth("beta") })).json()) as {
      grants: { externalUserId: string }[];
    };
    assert.deepEqual(beta.grants.map((g) => g.externalUserId), ["other"]);

    const cursorOf = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    for (const q of [
      "limit=0",
      "limit=201",
      "limit=x",
      "cursor=%%%",
      "cursor=bm9wZQ",
      `cursor=${cursorOf("1\0grant_x")}`, // a date Postgres would refuse
      `cursor=${cursorOf("2026-10-01T00:00:00.000Z\0a\0b")}`, // a NUL in the id
      `cursor=${cursorOf("2026-10-01T00:00:00.000Z\0a b")}`,
    ]) {
      const res = await app.request(`/v1/grants?all=true&${q}`, { headers: auth("askel") });
      assert.equal(res.status, 400, q);
    }
  });
});

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}
  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(text, params)).rows;
  }
  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

const BACKENDS: { name: string; make(): Promise<{ store: GrantStore; vault: TokenVault & CiphertextVault }> }[] = [
  {
    name: "memory",
    async make() {
      return { store: new MemoryStore(), vault: new MemoryTokenVault(MASTER) };
    },
  },
  {
    name: "postgres",
    async make() {
      const pg = new PGlite();
      const db = new PgDatabase(new PgliteExecutor(pg));
      const store = new PostgresStore(db);
      await store.ready();
      await pg.query(
        `INSERT INTO tenants (id, name, api_secret_hash) VALUES ('askel', 'askel', 'x'), ('beta', 'beta', 'x')`,
      );
      return { store, vault: new PostgresTokenVault(db, MASTER) };
    },
  },
];

function row(id: string, tenantId: string, externalUserId: string, createdAt: string, email = ADDRESS): Grant {
  return {
    id,
    tenantId,
    externalUserId,
    provider: "gmail",
    email,
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt,
    updatedAt: createdAt,
  };
}

for (const backend of BACKENDS) {
  describe(`grant lifecycle store methods (${backend.name})`, () => {
    it("reassignGrant moves a live grant and reports its previous owner; never a revoked one", async () => {
      const { store } = await backend.make();
      await store.putGrant(row("grant_1", "askel", "anon_1", "2026-10-01T00:00:00.000Z"));
      await store.putGrant({ ...row("grant_2", "askel", "anon_2", "2026-10-02T00:00:00.000Z"), status: "needs_reauth" });
      await store.putGrant({ ...row("grant_3", "askel", "anon_3", "2026-10-03T00:00:00.000Z"), status: "revoked" });

      const moved = await store.reassignGrant({
        id: "grant_2",
        tenantId: "askel",
        externalUserId: "google:1",
        scopes: ["s"],
        updatedAt: "2026-10-23T00:00:00.000Z",
      });
      assert.equal(moved?.previousExternalUserId, "anon_2");
      assert.equal(moved?.grant.status, "active");
      assert.equal(moved?.grant.externalUserId, "google:1");
      assert.deepEqual(moved?.grant.scopes, ["s"]);
      assert.equal(moved?.grant.id, "grant_2");

      const input = { tenantId: "askel", externalUserId: "x", scopes: [], updatedAt: "2026-10-23T00:00:00.000Z" };
      assert.equal(await store.reassignGrant({ ...input, id: "grant_3" }), undefined, "revoked stays revoked");
      assert.equal(await store.reassignGrant({ ...input, id: "grant_1", tenantId: "beta" }), undefined, "other tenant");
      assert.equal(await store.reassignGrant({ ...input, id: "grant_nope" }), undefined);
    });

    it("retireGrants retires only live grants of the tenant, optionally only one user's", async () => {
      const { store } = await backend.make();
      await store.putGrant(row("grant_1", "askel", "u1", "2026-10-01T00:00:00.000Z"));
      await store.putGrant(row("grant_2", "askel", "u2", "2026-10-02T00:00:00.000Z"));
      await store.putGrant(row("grant_9", "beta", "u1", "2026-10-03T00:00:00.000Z"));
      await store.putGrant(row("grant_new", "askel", "u1", "2026-10-04T00:00:00.000Z"));
      const base = { tenantId: "askel", replacedBy: "grant_new", updatedAt: "2026-10-23T00:00:00.000Z" };

      const own = await store.retireGrants({ ...base, ids: ["grant_1", "grant_2", "grant_9", "grant_new"], externalUserId: "u1" });
      assert.deepEqual(own.map((g) => g.id), ["grant_1"], "not u2's, not beta's, never itself");
      assert.equal((await store.getGrant("grant_1"))?.replacedBy, "grant_new");
      assert.equal((await store.getGrant("grant_9"))?.status, "active");
      assert.equal((await store.getGrant("grant_new"))?.status, "active");

      const any = await store.retireGrants({ ...base, ids: ["grant_1", "grant_2"] });
      assert.deepEqual(any.map((g) => g.id), ["grant_2"], "grant_1 already retired");
      assert.deepEqual(await store.retireGrants({ ...base, ids: [] }), []);
    });

    it("listTenantGrantsPage pages by createdAt then id and shows the last finished sync", async () => {
      const { store } = await backend.make();
      const at = "2026-10-05T00:00:00.000Z";
      for (const id of ["grant_c", "grant_a", "grant_b"]) await store.putGrant(row(id, "askel", id, at));
      await store.putGrant(row("grant_0", "askel", "u0", "2026-10-01T00:00:00.000Z"));
      await store.putGrant(row("grant_x", "beta", "ux", "2026-10-01T00:00:00.000Z"));
      const job = await store.enqueueSyncJob({ grantId: "grant_b", tenantId: "askel", kind: "incremental" });
      await store.claimQueuedSyncJobs(10);
      await store.completeSyncJob(job.id, {});
      const failed = await store.enqueueSyncJob({ grantId: "grant_c", tenantId: "askel", kind: "incremental" });
      await store.claimQueuedSyncJobs(10);
      await store.failSyncJob(failed.id, "boom");

      const p1 = await store.listTenantGrantsPage("askel", { limit: 2 });
      assert.deepEqual(p1.grants.map((g) => g.id), ["grant_0", "grant_a"]);
      assert.equal(p1.hasMore, true);
      const last = p1.grants.at(-1)!;
      const p2 = await store.listTenantGrantsPage("askel", { limit: 2, after: { createdAt: last.createdAt, id: last.id } });
      assert.deepEqual(p2.grants.map((g) => g.id), ["grant_b", "grant_c"]);
      assert.equal(p2.hasMore, false);
      assert.ok(p2.grants[0]!.lastSyncAt, "completed sync shown");
      assert.equal(p2.grants[1]!.lastSyncAt, undefined, "a failed sync is not a finished one");
    });

    it("listTenantGrantsPage never repeats a grant written with sub-millisecond precision", async () => {
      const { store } = await backend.make();
      await store.putGrant(row("grant_a", "beta", "u1", "2026-10-01T00:00:00.123Z"));
      await store.putGrant(row("grant_b", "beta", "u2", "2026-10-01T00:00:00.123Z"));
      if (backend.name === "postgres") {
        // A row written by SQL rather than by this code keeps microseconds.
        const pg = (store as unknown as { db: { sql: { query: (t: string, p: unknown[]) => Promise<unknown> } } }).db;
        await pg.sql.query(`UPDATE grants SET created_at = '2026-10-01T00:00:00.123456Z' WHERE id = 'grant_a'`, []);
      }
      const seen: string[] = [];
      let after: { createdAt: string; id: string } | undefined;
      for (let i = 0; i < 4; i += 1) {
        const page = await store.listTenantGrantsPage("beta", { limit: 1, ...(after ? { after } : {}) });
        seen.push(...page.grants.map((g) => g.id));
        const last = page.grants.at(-1);
        if (!page.hasMore || !last) break;
        after = { createdAt: last.createdAt, id: last.id };
      }
      assert.deepEqual(seen, ["grant_a", "grant_b"]);
    });

    it("connectGrant under reuse: one live grant, same id, for concurrent Connects on the same store", async () => {
      const { store, vault } = await backend.make();
      await store.putGrant(row("grant_old", "askel", "anon_1", "2026-10-01T00:00:00.000Z"));
      await vault.seal("1//old", { grantId: "grant_old", tenantId: "askel" });
      let n = 0;
      const connect = (user: string) =>
        connectGrant({
          store,
          vault,
          policy: "reuse",
          tenantId: "askel",
          externalUserId: user,
          provider: "gmail",
          email: ADDRESS,
          verifiedAddress: ADDRESS,
          fallbackEmail: "unknown@gmail.com",
          refreshToken: `1//new-${user}`,
          scopes: ["s"],
          createdAt: () => `2026-10-23T00:00:0${(n += 1)}.000Z`,
          newGrantId: () => `grant_new_${n}`,
        });
      const [a, b] = await Promise.all([connect("google:1"), connect("google:2")]);
      assert.equal(a.grant.id, "grant_old");
      assert.equal(b.grant.id, "grant_old");
      assert.equal(a.reused && b.reused, true);
      const live = await store.findLiveGrantsByAddress("askel", "gmail", ADDRESS);
      assert.deepEqual(live.map((g) => g.id), ["grant_old"]);
      // Both consents are for this mailbox; whichever token was sealed last is
      // kept, and it works for whichever of the two ends up owning the grant.
      const token = await vault.open((await vault.getCiphertext("grant_old"))!, { grantId: "grant_old", tenantId: "askel" });
      assert.ok(["1//new-google:1", "1//new-google:2"].includes(token), "a fresh token, not the old one");
    });
  });
}

describe("pickReuseTarget", () => {
  const g = (id: string, user: string): Grant => row(id, "askel", user, `2026-10-0${id.slice(-1)}T00:00:00.000Z`);
  it("prefers the connecting user's own grant, then the named one, then the newest", () => {
    const live = [g("grant_1", "u1"), g("grant_2", "u2"), g("grant_3", "u3")];
    assert.equal(pickReuseTarget(live, "u1", "grant_2")?.id, "grant_1");
    assert.equal(pickReuseTarget(live, "u9", "grant_2")?.id, "grant_2");
    assert.equal(pickReuseTarget(live, "u9", undefined)?.id, "grant_3");
    assert.equal(pickReuseTarget([], "u1", undefined), undefined);
  });
});

describe("scripts/grant-health-report.sql", () => {
  const report = readFileSync(new URL("../../../scripts/grant-health-report.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("\\echo") && !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((query) => query.trim())
    .filter(Boolean);

  it("counts grants by status, age and last sync, and prints no address or id", async () => {
    assert.equal(report.length, 2);
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const store = new PostgresStore(db);
    await store.ready();
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    await store.putGrant(row("grant_new", "default", "google:1", ago(1)));
    await store.putGrant({ ...row("grant_mid", "default", "anon_1", ago(20)), status: "needs_reauth" });
    await store.putGrant({ ...row("grant_old", "default", "uuid-1", ago(100)), status: "revoked", replacedBy: "grant_new" });
    await pg.query(`UPDATE grants SET replaced_by = 'grant_new' WHERE id = 'grant_old'`);
    const job = await store.enqueueSyncJob({ grantId: "grant_new", tenantId: "default", kind: "incremental" });
    await store.claimQueuedSyncJobs(10);
    await store.completeSyncJob(job.id, {});

    const [byStatus, byKind] = report as [string, string];
    const status = (await pg.query<Record<string, unknown>>(byStatus)).rows;
    assert.deepEqual(
      status.map((r) => [r.status, r.grants, r.under_7_days, r.days_7_to_30, r.over_90_days, r.replaced]),
      [
        ["active", 1, 1, 0, 0, 0],
        ["needs_reauth", 1, 0, 1, 0, 0],
        ["revoked", 1, 0, 0, 1, 1],
      ],
    );
    const kind = (await pg.query<Record<string, unknown>>(byKind)).rows;
    assert.deepEqual(
      kind.map((r) => [r.identity_kind, r.status, r.grants, r.synced_7_days, r.never]),
      [
        ["anonymous", "needs_reauth", 1, 0, 1],
        ["google", "active", 1, 1, 0],
      ],
    );
    const printed = JSON.stringify([status, kind]);
    assert.equal(printed.includes("@"), false, "no address");
    assert.equal(/grant_|google:|anon_/.test(printed), false, "no grant or user id");
  });
});
