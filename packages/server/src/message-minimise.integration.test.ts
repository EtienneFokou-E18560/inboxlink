/**
 * Issue #86: the synced store keeps inbox mail only, no bodies, subject and
 * snippet encrypted, rows deleted after a time limit, one first look per
 * connection, ids-only webhooks. Rows written before this change stay as they are.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { loadConfig } from "./config.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import { SCHEMA_SQL } from "./db/schema.js";
import type { SqlExecutor } from "./db/sql.js";
import { DEFAULT_MESSAGE_TTL_DAYS, isStorableMessage } from "./message-rules.js";
import { deriveMessageKey, openMessageField, sealMessageField } from "./message-seal.js";
import { drainSyncJobs } from "./queue/sync-queue.js";
import { createApp } from "./routes/app.js";
import { applyGmailPushNotification } from "./sync/gmail-push.js";
import { syncGmailGrant } from "./sync/gmail-sync.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import type { WebhookBus, WebhookEventType } from "./webhooks/deliver.js";

const REFRESH = "1//vaulted-refresh-for-minimise";
const ACCESS = "ya29.minimise-access-token";
const MASTER = "test-master-key-for-issue-86";
const DAY = 86_400_000;
/** One fixed clock for every date in this file. */
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const now = () => NOW;

type Resource = { labels: string[]; ageDays: number; subject?: string };

/** Fake Gmail: what each message looks like now, the history pages, and every hit. */
let resources: Record<string, Resource> = {};
let listIds: string[] = [];
let historyPages: Array<{ history?: unknown[]; historyId: string }> = [];
let historyStatus = 200;
let profileHistoryId = "9000";
let hits: string[] = [];
let google: Server;
let tokenUrl = "";
let gmailApiBaseUrl = "";

const BODY = "Private body text that must never be stored";

function resource(id: string) {
  const r = resources[id];
  if (!r) return undefined;
  const subject = r.subject ?? `Subject ${id}`;
  return {
    id,
    threadId: `t-${id}`,
    labelIds: r.labels,
    snippet: `Snippet ${id}`,
    internalDate: String(NOW - r.ageDays * DAY),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Ada Sender <ada@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: subject },
      ],
      body: { data: Buffer.from(BODY).toString("base64url") },
    },
  };
}

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
    req.on("error", reject);
  });
}

before(async () => {
  google = createServer(async (req, res) => {
    const url = req.url ?? "/";
    await readBody(req);
    hits.push(url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/token")) return json(200, { access_token: ACCESS, expires_in: 3600 });
    if (url.startsWith("/gmail/v1/users/me/profile")) {
      return json(200, { emailAddress: "me@example.com", historyId: profileHistoryId });
    }
    if (url.startsWith("/gmail/v1/users/me/history")) {
      if (historyStatus !== 200) return json(historyStatus, { error: { code: historyStatus } });
      return json(200, historyPages[0] ?? { history: [], historyId: profileHistoryId });
    }
    if (url.startsWith("/gmail/v1/users/me/messages/")) {
      const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
      const body = resource(id);
      return body ? json(200, body) : json(404, { error: { code: 404 } });
    }
    if (url.startsWith("/gmail/v1/users/me/messages")) {
      // Real Gmail filters by labelIds; the fake does too so the test sees what the sync asked for.
      const wanted = new URL(url, "http://gmail.local").searchParams.getAll("labelIds");
      const ids = listIds.filter((id) => wanted.every((label) => resources[id]?.labels.includes(label)));
      return json(200, { messages: ids.map((id) => ({ id })) });
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
  resources = {};
  listIds = [];
  historyPages = [];
  historyStatus = 200;
  profileHistoryId = "9000";
  hits = [];
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

function grantFor(id: string): Grant {
  const at = new Date(NOW - DAY).toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "gmail",
    email: "me@example.com",
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

async function pgSetup(pglite = new PGlite()) {
  const db = new PgDatabase(new PgliteExecutor(pglite));
  const store = new PostgresStore(db, { masterKey: MASTER });
  const vault = new PostgresTokenVault(db, MASTER);
  return { pglite, db, store, vault };
}

async function connect(
  store: MemoryStore | PostgresStore,
  vault: MemoryTokenVault | PostgresTokenVault,
  id: string,
): Promise<Grant> {
  const grant = grantFor(id);
  await store.putGrant(grant);
  await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
  return grant;
}

function sync(
  store: MemoryStore | PostgresStore,
  vault: MemoryTokenVault | PostgresTokenVault,
  grant: Grant,
  extra: { forceBootstrap?: boolean } = {},
) {
  return syncGmailGrant({ store, vault, gmail: gmail(), grant, now, ...extra });
}

function messageGets(): string[] {
  return hits.filter((url) => url.startsWith("/gmail/v1/users/me/messages/"));
}

function listCalls(): string[] {
  return hits.filter((url) => url.startsWith("/gmail/v1/users/me/messages?"));
}

describe("issue #86: inbox only", () => {
  it("the first look lists the inbox only and never stores sent mail", async () => {
    const { store, vault } = await pgSetup();
    resources = {
      "in-1": { labels: ["INBOX", "UNREAD"], ageDays: 1 },
      "sent-1": { labels: ["SENT"], ageDays: 1 },
      "in-sent": { labels: ["INBOX", "SENT"], ageDays: 1 },
      "archived-1": { labels: ["CATEGORY_UPDATES"], ageDays: 1 },
    };
    listIds = ["in-1", "sent-1", "in-sent", "archived-1"];
    const grant = await connect(store, vault, "grant_inbox_first");

    const result = await sync(store, vault, grant);
    assert.equal(result.status, "ok");
    assert.equal(result.mode, "bootstrap");
    assert.ok(listCalls().every((url) => new URL(url, "http://g").searchParams.getAll("labelIds").includes("INBOX")));
    assert.deepEqual(await store.listMessageIds(grant.id), ["in-1"]);
  });

  it("incremental sync skips new mail outside the inbox and removes a message archived later", async () => {
    const { store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 2 } };
    listIds = ["in-1"];
    profileHistoryId = "100";
    const grant = await connect(store, vault, "grant_inbox_incr");
    await sync(store, vault, grant);
    assert.deepEqual(await store.listMessageIds(grant.id), ["in-1"]);

    // Later: the person sends a reply, a new inbox message arrives, and in-1 is archived.
    resources["sent-2"] = { labels: ["SENT"], ageDays: 0 };
    resources["in-2"] = { labels: ["INBOX"], ageDays: 0 };
    resources["in-1"] = { labels: ["CATEGORY_PERSONAL"], ageDays: 2 };
    historyPages = [
      {
        historyId: "200",
        history: [
          { id: "101", messagesAdded: [{ message: { id: "sent-2", labelIds: ["SENT"] } }] },
          { id: "102", messagesAdded: [{ message: { id: "in-2", labelIds: ["INBOX", "UNREAD"] } }] },
          { id: "103", labelsRemoved: [{ message: { id: "in-1", labelIds: [] }, labelIds: ["INBOX"] }] },
        ],
      },
    ];
    hits = [];
    const result = await sync(store, vault, grant);
    assert.equal(result.status, "ok");
    assert.equal(result.mode, "incremental");
    assert.deepEqual(await store.listMessageIds(grant.id), ["in-2"]);
    // Sent mail is not even fetched: its history entry already says it is not in the inbox.
    assert.ok(!messageGets().some((url) => url.includes("/messages/sent-2")));
    // Messages are read as metadata, never in full.
    assert.ok(messageGets().every((url) => new URL(url, "http://g").searchParams.get("format") === "metadata"));
  });

  it("isStorableMessage keeps INBOX and drops sent, drafts, spam and trash", () => {
    assert.equal(isStorableMessage(["INBOX", "UNREAD"]), true);
    assert.equal(isStorableMessage(["INBOX", "SENT"]), false);
    assert.equal(isStorableMessage(["SENT"]), false);
    assert.equal(isStorableMessage(["INBOX", "TRASH"]), false);
    assert.equal(isStorableMessage(["INBOX", "SPAM"]), false);
    assert.equal(isStorableMessage(["DRAFT"]), false);
    assert.equal(isStorableMessage([]), false);
  });
});

describe("issue #86: no bodies, encrypted subject and snippet", () => {
  it("a synced row has no payload, no plain subject or snippet, and the store list decrypts them", async () => {
    const { pglite, store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1, subject: "Offer from Northwind" } };
    listIds = ["in-1"];
    const grant = await connect(store, vault, "grant_no_body");
    await sync(store, vault, grant);

    const rows = (
      await pglite.query<{ payload: unknown; subject: string; snippet: string; subject_ct: Uint8Array; snippet_ct: Uint8Array; labels: unknown }>(
        `SELECT payload, subject, snippet, subject_ct, snippet_ct, labels FROM messages WHERE grant_id = $1`,
        [grant.id],
      )
    ).rows;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.payload, null);
    assert.equal(row.subject, "");
    assert.equal(row.snippet, "");
    assert.ok(row.subject_ct && row.subject_ct.length > 0);
    assert.ok(row.snippet_ct && row.snippet_ct.length > 0);
    assert.ok(!Buffer.from(row.subject_ct).toString("latin1").includes("Northwind"));
    assert.deepEqual(row.labels, ["INBOX"]);
    const dump = JSON.stringify((await pglite.query(`SELECT * FROM messages`)).rows);
    assert.ok(!dump.includes("Private body"), "no body text anywhere in the table");
    assert.ok(!dump.includes("ada@example.com"), "no sender address in the table");

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
    const res = await app.request(`/v1/grants/${grant.id}/messages`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    assert.equal(body.messages.length, 1);
    const listed = body.messages[0]!;
    assert.equal(listed.subject, "Offer from Northwind");
    assert.equal(listed.snippet, "Snippet in-1");
    assert.equal(listed.providerMessageId, "in-1");
    assert.equal(listed.threadId, "t-in-1");
    assert.deepEqual(listed.labels, ["INBOX"]);
    assert.deepEqual(listed.folderIds, ["INBOX"]);
    assert.equal(listed.body, undefined);
    assert.deepEqual(listed.from, []);
  });

  it("the memory store keeps no body or addresses either", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["in-1"];
    const grant = await connect(store, vault, "grant_memory_no_body");
    await sync(store, vault, grant);
    const [message] = await store.listMessages(grant.id);
    assert.ok(message);
    assert.equal(message.body, undefined);
    assert.deepEqual(message.from, []);
    assert.deepEqual(message.to, []);
    assert.equal(message.subject, "Subject in-1");
  });

  it("ciphertext opens only for its own grant and key", () => {
    const key = deriveMessageKey(MASTER);
    const sealed = sealMessageField(key, "Interview on Tuesday", { grantId: "grant_a", field: "subject" });
    assert.equal(openMessageField(key, sealed, { grantId: "grant_a", field: "subject" }), "Interview on Tuesday");
    assert.throws(() => openMessageField(key, sealed, { grantId: "grant_b", field: "subject" }));
    assert.throws(() => openMessageField(key, sealed, { grantId: "grant_a", field: "snippet" }));
    assert.throws(() => openMessageField(deriveMessageKey("another-master-key-123"), sealed, { grantId: "grant_a", field: "subject" }));
    // Its own key: the vault's key (sha256 of the master key) does not open it.
    assert.notDeepEqual(key, Buffer.from(MASTER));
  });

  it("a row copied to another grant does not decrypt there", async () => {
    const { pglite, store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1, subject: "Secret subject" } };
    listIds = ["in-1"];
    const a = await connect(store, vault, "grant_copy_a");
    const b = await connect(store, vault, "grant_copy_b");
    await sync(store, vault, a);
    await pglite.query(
      `INSERT INTO messages (id, grant_id, provider_message_id, thread_id, subject, snippet, payload, labels, subject_ct, snippet_ct, received_at)
       SELECT 'msg_copied', $1, provider_message_id, thread_id, subject, snippet, payload, labels, subject_ct, snippet_ct, received_at
       FROM messages WHERE grant_id = $2`,
      [b.id, a.id],
    );
    const page = await store.listMessagesPage(b.id, { offset: 0, limit: 10 });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]!.subject, "");
    assert.equal(page.messages[0]!.snippet, "");
  });
});

describe("issue #86: time limit", () => {
  it("defaults to 30 days and reads INBOXLINK_MESSAGE_TTL_DAYS", () => {
    assert.equal(DEFAULT_MESSAGE_TTL_DAYS, 30);
    assert.equal(loadConfig({}).messageTtlDays, 30);
    assert.equal(loadConfig({ INBOXLINK_MESSAGE_TTL_DAYS: "7" }).messageTtlDays, 7);
    assert.equal(loadConfig({ INBOXLINK_MESSAGE_TTL_DAYS: "nonsense" }).messageTtlDays, 30);
  });

  it("the first look skips mail older than the limit", async () => {
    const { store, vault } = await pgSetup();
    resources = {
      fresh: { labels: ["INBOX"], ageDays: 3 },
      stale: { labels: ["INBOX"], ageDays: 45 },
    };
    listIds = ["fresh", "stale"];
    const grant = await connect(store, vault, "grant_ttl_first");
    await sync(store, vault, grant);
    assert.deepEqual(await store.listMessageIds(grant.id), ["fresh"]);
  });

  it("rows past the limit go at the next sync", async () => {
    const { store, vault } = await pgSetup();
    resources = {
      young: { labels: ["INBOX"], ageDays: 1 },
      ageing: { labels: ["INBOX"], ageDays: 29 },
    };
    listIds = ["young", "ageing"];
    profileHistoryId = "300";
    const grant = await connect(store, vault, "grant_ttl_sync");
    await sync(store, vault, grant);
    assert.equal((await store.listMessageIds(grant.id)).length, 2);

    // Two days later "ageing" is 31 days old.
    historyPages = [{ historyId: "300", history: [] }];
    const later = () => NOW + 2 * DAY;
    const result = await syncGmailGrant({ store, vault, gmail: gmail(), grant, now: later });
    assert.equal(result.status, "ok");
    assert.equal(result.expired, 1);
    assert.deepEqual(await store.listMessageIds(grant.id), ["young"]);
  });

  it("rows past the limit go at the daily drain-sync-jobs cron, for every grant", async () => {
    const { store, vault } = await pgSetup();
    // Two mailboxes, so their Gmail message ids differ.
    resources = { "a-old": { labels: ["INBOX"], ageDays: 29 }, "a-recent": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["a-old", "a-recent"];
    const a = await connect(store, vault, "grant_cron_a");
    const b = await connect(store, vault, "grant_cron_b");
    assert.equal((await sync(store, vault, a)).status, "ok");
    resources = { "b-old": { labels: ["INBOX"], ageDays: 29 }, "b-recent": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["b-old", "b-recent"];
    assert.equal((await sync(store, vault, b)).status, "ok");

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
      cronSecret: "cron-secret-for-tests",
      messageTtlDays: 30,
      now: () => NOW + 2 * DAY,
    });
    const denied = await app.request("/v1/internal/cron/drain-sync-jobs");
    assert.equal(denied.status, 401);
    assert.equal((await store.listMessageIds(a.id)).length, 2, "an unauthorised call deletes nothing");

    const res = await app.request("/v1/internal/cron/drain-sync-jobs", {
      headers: { authorization: "Bearer cron-secret-for-tests" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; expiredMessages: number };
    assert.equal(body.expiredMessages, 2);
    assert.deepEqual(await store.listMessageIds(a.id), ["a-recent"]);
    assert.deepEqual(await store.listMessageIds(b.id), ["b-recent"]);
  });

  it("a time-limit delete running during a sync leaves no expired row and keeps every recent one", async () => {
    const { store, vault } = await pgSetup();
    const grant = await connect(store, vault, "grant_ttl_race");
    resources = {};
    listIds = [];
    for (let i = 0; i < 20; i++) {
      // At NOW, even ones are 31 days old (past the limit) and odd ones 5 days old.
      resources[`m-${i}`] = { labels: ["INBOX"], ageDays: i % 2 === 0 ? 31 : 5 };
      listIds.push(`m-${i}`);
    }
    profileHistoryId = "400";
    // First look ten days earlier, when every message was still inside the limit.
    await syncGmailGrant({ store, vault, gmail: gmail(), grant, now: () => NOW - 10 * DAY });
    assert.equal((await store.listMessageIds(grant.id)).length, 20);

    // Now: history touches every message (a label change) and adds new ones, while the
    // cron's delete runs at the same time. The sync must not write an expired row back.
    const cutoff = new Date(NOW - 30 * DAY).toISOString();
    for (let round = 0; round < 5; round++) {
      const added = `new-${round}`;
      resources[added] = { labels: ["INBOX"], ageDays: 0 };
      historyPages = [
        {
          historyId: String(401 + round),
          history: [
            ...Object.keys(resources).map((id, n) => ({
              id: String(1000 * round + n),
              labelsAdded: [{ message: { id }, labelIds: ["STARRED"] }],
            })),
            { id: `${round}-add`, messagesAdded: [{ message: { id: added, labelIds: ["INBOX"] } }] },
          ],
        },
      ];
      await Promise.all([
        store.deleteExpiredMessages({ before: cutoff }),
        syncGmailGrant({ store, vault, gmail: gmail(), grant, now }),
        store.deleteExpiredMessages({ before: cutoff }),
      ]);
      const ids = new Set(await store.listMessageIds(grant.id));
      for (let i = 0; i < 20; i += 2) assert.ok(!ids.has(`m-${i}`), `round ${round}: m-${i} is past the limit`);
      for (let i = 1; i < 20; i += 2) assert.ok(ids.has(`m-${i}`), `round ${round}: m-${i} is recent and stays`);
      for (let r = 0; r <= round; r++) assert.ok(ids.has(`new-${r}`), `round ${round}: new-${r} stays`);
    }
  });
});

describe("issue #86: one first look per connection", () => {
  it("a full sync after the first look reads only new mail", async () => {
    const { store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["in-1"];
    profileHistoryId = "500";
    const grant = await connect(store, vault, "grant_first_once");
    const first = await sync(store, vault, grant, { forceBootstrap: true });
    assert.equal(first.mode, "bootstrap");
    assert.equal(listCalls().length, 1);

    hits = [];
    historyPages = [{ historyId: "500", history: [] }];
    const second = await sync(store, vault, grant, { forceBootstrap: true });
    assert.equal(second.status, "ok");
    assert.equal(second.mode, "incremental");
    assert.equal(listCalls().length, 0, "no second look back");
  });

  it("an expired history watermark after the first look restarts from now without looking back", async () => {
    const { store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["in-1"];
    profileHistoryId = "600";
    const grant = await connect(store, vault, "grant_first_expired");
    await sync(store, vault, grant);

    resources["in-older"] = { labels: ["INBOX"], ageDays: 2 };
    listIds = ["in-1", "in-older"];
    historyStatus = 404;
    profileHistoryId = "900";
    hits = [];
    const result = await sync(store, vault, grant);
    assert.equal(result.status, "ok");
    assert.equal(result.mode, "incremental");
    assert.equal(result.historyId, "900");
    assert.equal(listCalls().length, 0);
    assert.equal((await store.getSyncCursor(grant.id))?.value, "900");
    assert.deepEqual(await store.listMessageIds(grant.id), ["in-1"]);
  });

  it("a cursor seeded by the Gmail watch before the first look still gets its first look", async () => {
    const { store, vault } = await pgSetup();
    resources = { "in-1": { labels: ["INBOX"], ageDays: 1 } };
    listIds = ["in-1"];
    const grant = await connect(store, vault, "grant_watch_seeded");
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "700",
      updatedAt: new Date(NOW).toISOString(),
      watchExpiration: new Date(NOW + 7 * DAY).toISOString(),
    });
    const result = await sync(store, vault, grant, { forceBootstrap: true });
    assert.equal(result.mode, "bootstrap");
    assert.deepEqual(await store.listMessageIds(grant.id), ["in-1"]);
    // The watch expiration survives the bootstrap's cursor write.
    assert.equal((await store.getSyncCursor(grant.id))?.watchExpiration, new Date(NOW + 7 * DAY).toISOString());
  });
});

describe("issue #86: webhooks carry ids only", () => {
  it("message.created has no subject, snippet, addresses or body", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    resources = { "in-1": { labels: ["INBOX"], ageDays: 0, subject: "Do not leak me" } };
    profileHistoryId = "800";
    const grant = await connect(store, vault, "grant_webhook_ids");
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "799",
      updatedAt: new Date(NOW).toISOString(),
    });
    historyPages = [
      { historyId: "800", history: [{ id: "800", messagesAdded: [{ message: { id: "in-1", labelIds: ["INBOX"] } }] }] },
    ];
    const events: Array<{ type: WebhookEventType; data: Record<string, unknown> }> = [];
    const bus: WebhookBus = {
      enabled: true,
      async emit(type, data) {
        events.push({ type, data });
        return { delivered: true, attempts: 1 } as never;
      },
    };
    await applyGmailPushNotification({
      store,
      vault,
      gmail: gmail(),
      webhooks: bus,
      notification: { emailAddress: "me@example.com", historyId: "800" },
      now,
    });
    const created = events.filter((e) => e.type === "message.created");
    assert.equal(created.length, 1);
    assert.deepEqual(Object.keys(created[0]!.data).sort(), [
      "externalUserId",
      "grantId",
      "messageId",
      "provider",
      "providerMessageId",
      "receivedAt",
      "tenantId",
      "threadId",
    ]);
    assert.ok(!JSON.stringify(events).includes("Do not leak me"));
  });
});

describe("issue #86: rows written before this change stay as they are", () => {
  /** The `messages` and `sync_cursors` tables as main created them before #86. */
  const OLD_SCHEMA = `
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_secret_hash TEXT NOT NULL, webhook_secret TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE grants (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), external_user_id TEXT NOT NULL, provider TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, scopes JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE sync_cursors (grant_id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE, kind TEXT NOT NULL, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), watch_expiration TIMESTAMPTZ);
    CREATE TABLE messages (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE, provider_message_id TEXT NOT NULL, thread_id TEXT, subject TEXT NOT NULL, snippet TEXT NOT NULL, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (grant_id, provider_message_id));
    CREATE INDEX messages_grant_received_idx ON messages (grant_id, received_at DESC);
  `;

  function oldPayload(id: string, labels: string[], ageDays: number) {
    const at = new Date(NOW - ageDays * DAY).toISOString();
    return {
      id: `msg_${id}`,
      grantId: "grant_existing",
      providerMessageId: id,
      threadId: `t-${id}`,
      subject: `Old subject ${id}`,
      snippet: `Old snippet ${id}`,
      from: [{ email: "lin@example.com" }],
      to: [{ email: "me@example.com" }],
      sentAt: at,
      receivedAt: at,
      folderIds: labels,
      labels,
      hasAttachments: false,
      body: { text: "Old body" },
    };
  }

  async function snapshot(pglite: PGlite) {
    return (
      await pglite.query<Record<string, unknown>>(
        `SELECT id, provider_message_id, thread_id, subject, snippet, payload, received_at
         FROM messages WHERE payload IS NOT NULL ORDER BY id`,
      )
    ).rows;
  }

  it("the startup DDL upgrades an old database twice over without touching its rows", async () => {
    const pglite = new PGlite();
    await pglite.exec(OLD_SCHEMA);
    await pglite.exec(`INSERT INTO tenants (id, name, api_secret_hash) VALUES ('default', 'default', 'x')`);
    await pglite.query(
      `INSERT INTO grants (id, tenant_id, external_user_id, provider, email, status, scopes) VALUES ('grant_existing', 'default', 'user-1', 'gmail', 'me@example.com', 'active', '[]')`,
    );
    await pglite.query(
      `INSERT INTO sync_cursors (grant_id, kind, value) VALUES ('grant_existing', 'gmail_history', '1000')`,
    );
    const fixtures: Array<[string, string[], number]> = [
      ["old-inbox-recent", ["INBOX"], 2],
      ["old-inbox-ancient", ["INBOX"], 200],
      ["old-sent", ["SENT"], 3],
      ["old-archived", ["CATEGORY_UPDATES"], 4],
    ];
    for (const [id, labels, age] of fixtures) {
      const p = oldPayload(id, labels, age);
      await pglite.query(
        `INSERT INTO messages (id, grant_id, provider_message_id, thread_id, subject, snippet, payload, received_at)
         VALUES ($1, 'grant_existing', $2, $3, $4, $5, $6, $7)`,
        [p.id, id, p.threadId, p.subject, p.snippet, JSON.stringify(p), p.receivedAt],
      );
    }
    const before = await snapshot(pglite);
    assert.equal(before.length, 4);

    // Startup migration twice (two cold starts), then each new rule runs against these rows.
    const { db, store, vault } = await pgSetup(pglite);
    await db.ensure();
    await new PgDatabase(new PgliteExecutor(pglite)).ensure();
    const grant = (await store.getGrant("grant_existing"))!;
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });

    // An existing connection already had its first look: a full sync reads new mail only.
    resources = {
      "old-inbox-recent": { labels: ["CATEGORY_PERSONAL"], ageDays: 2 },
      "old-sent": { labels: ["SENT"], ageDays: 3 },
      "new-1": { labels: ["INBOX"], ageDays: 0 },
    };
    listIds = ["new-1"];
    historyPages = [
      {
        historyId: "1100",
        history: [
          // The old inbox row was archived and the old sent row relabelled: new rules would drop
          // both, but these rows predate them.
          { id: "1001", labelsRemoved: [{ message: { id: "old-inbox-recent" }, labelIds: ["INBOX"] }] },
          { id: "1002", labelsAdded: [{ message: { id: "old-sent" }, labelIds: ["STARRED"] }] },
          { id: "1003", messagesAdded: [{ message: { id: "new-1", labelIds: ["INBOX"] } }] },
        ],
      },
    ];
    const result = await sync(store, vault, grant, { forceBootstrap: true });
    assert.equal(result.status, "ok");
    assert.equal(result.mode, "incremental");
    assert.equal(listCalls().length, 0);

    // New mail on the same connection follows the new rules.
    const fresh = (
      await pglite.query<{ payload: unknown }>(`SELECT payload FROM messages WHERE provider_message_id = 'new-1'`)
    ).rows;
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.payload, null);
    // The store list serves old rows as they were, next to the new one.
    const page = await store.listMessagesPage(grant.id, { offset: 0, limit: 10 });
    assert.equal(page.messages.length, 5);
    assert.ok(page.messages.some((m) => m.subject === "Old subject old-inbox-recent" && m.body?.text === "Old body"));
    assert.ok(page.messages.some((m) => m.subject === "Subject new-1" && m.body === undefined));

    // The daily cron's time-limit delete, a year on: only the new row goes.
    const cutoff = new Date(NOW + 365 * DAY).toISOString();
    assert.equal(await store.deleteExpiredMessages({ before: cutoff }), 1);
    assert.equal(await store.deleteExpiredMessages({ before: cutoff, grantId: grant.id }), 0);

    assert.deepEqual(await snapshot(pglite), before, "old rows are byte-for-byte unchanged");
  });

  it("every column an index or partial index names is added before that index", () => {
    const statements = SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean);
    const addedAt = new Map<string, number>();
    statements.forEach((statement, index) => {
      const add = /ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/i.exec(statement);
      if (add) addedAt.set(`${add[1]}.${add[2]}`, index);
    });
    statements.forEach((statement, index) => {
      const idx = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON (\w+)\s*\(([^)]*)\)(?:\s+WHERE\s+(.*))?/is.exec(statement);
      if (!idx) return;
      const table = idx[1]!;
      const text = `${idx[2]} ${idx[3] ?? ""}`;
      for (const [key, at] of addedAt) {
        const [t, column] = key.split(".");
        if (t === table && new RegExp(`\\b${column}\\b`).test(text)) {
          assert.ok(at < index, `${key} is added before index statement ${index}`);
        }
      }
    });
    assert.ok(addedAt.has("messages.subject_ct"));
    assert.ok(addedAt.has("messages.snippet_ct"));
    assert.ok(addedAt.has("messages.labels"));
    assert.ok(addedAt.has("sync_cursors.first_look_at"));
  });
});

describe("issue #86: drainSyncJobs passes the time limit through", () => {
  it("a queued job deletes expired rows for its grant", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    resources = { a: { labels: ["INBOX"], ageDays: 5 } };
    listIds = ["a"];
    profileHistoryId = "50";
    const grant = await connect(store, vault, "grant_drain_ttl");
    await sync(store, vault, grant);
    historyPages = [{ historyId: "50", history: [] }];
    await store.enqueueSyncJob({ grantId: grant.id, tenantId: grant.tenantId, kind: "incremental" });
    const summary = await drainSyncJobs({ store, vault, gmail: gmail(), messageTtlDays: 3, now });
    assert.equal(summary.completed, 1);
    assert.deepEqual(await store.listMessageIds(grant.id), []);
  });
});

describe("issue #86: live reads are unchanged", () => {
  it("source=live and messages.get still return full messages, sent mail included, and write nothing", async () => {
    const { pglite, store, vault } = await pgSetup();
    resources = {
      "in-1": { labels: ["INBOX"], ageDays: 1 },
      "sent-1": { labels: ["SENT"], ageDays: 1 },
    };
    listIds = ["in-1", "sent-1"];
    const grant = await connect(store, vault, "grant_live_reads");
    await sync(store, vault, grant);
    const rowsBefore = (await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows;

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
    const live = await app.request(`/v1/grants/${grant.id}/messages?source=live&label=SENT`);
    assert.equal(live.status, 200);
    const liveBody = (await live.json()) as { source: string; messages: Array<{ providerMessageId: string; from: Array<{ email: string }>; subject: string }> };
    assert.equal(liveBody.source, "live");
    assert.deepEqual(liveBody.messages.map((m) => m.providerMessageId), ["sent-1"]);
    assert.equal(liveBody.messages[0]!.from[0]!.email, "ada@example.com");
    assert.equal(liveBody.messages[0]!.subject, "Subject sent-1");

    const one = await app.request(`/v1/grants/${grant.id}/messages/in-1`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { message: { body?: { text?: string }; from: Array<{ email: string }> } };
    assert.equal(oneBody.message.body?.text, BODY);
    assert.equal(oneBody.message.from[0]!.email, "ada@example.com");

    assert.deepEqual((await pglite.query(`SELECT * FROM messages ORDER BY id`)).rows, rowsBefore);
  });
});
