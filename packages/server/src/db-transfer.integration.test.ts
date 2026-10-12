import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant, Message } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { createApp } from "./routes/app.js";
import { applyGmailPushNotification } from "./sync/gmail-push.js";
import { MemoryStore, type GrantStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import { createWebhookBus } from "./webhooks/deliver.js";

/**
 * Guards against reading the whole message cache (full payloads) on hot paths:
 * Gmail push and the default store-backed message list.
 */

const REFRESH = "1//vaulted-refresh-db-transfer";
const ACCESS = "ya29.db-transfer-access";
const MASTER = "test-master-key-at-least-16";

/** Records every SQL statement so tests can assert what was (not) read. */
class RecordingPgliteExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push(text.replace(/\s+/g, " ").trim());
    const result = await this.db.query<T>(text, params);
    return result.rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

/** Wrap `listMessages` (full-payload read) with a call counter. */
function countFullReads(store: GrantStore): { count: () => number } {
  let calls = 0;
  const original = store.listMessages.bind(store);
  store.listMessages = async (grantId: string) => {
    calls += 1;
    return original(grantId);
  };
  return { count: () => calls };
}

/** Statements that pull message payloads without a LIMIT (i.e. the whole cache). */
function unboundedPayloadReads(executor: RecordingPgliteExecutor): string[] {
  return executor.statements.filter(
    (sql) => /SELECT payload FROM messages/i.test(sql) && !/\bLIMIT\b/i.test(sql),
  );
}

type Backend = {
  name: string;
  store: GrantStore;
  vault: MemoryTokenVault | PostgresTokenVault;
  executor?: RecordingPgliteExecutor;
  close: () => Promise<void>;
};

async function memoryBackend(): Promise<Backend> {
  return {
    name: "memory",
    store: new MemoryStore(),
    vault: new MemoryTokenVault(MASTER),
    close: async () => {},
  };
}

async function postgresBackend(): Promise<Backend> {
  const pg = new PGlite();
  const executor = new RecordingPgliteExecutor(pg);
  const db = new PgDatabase(executor);
  return {
    name: "postgres",
    store: new PostgresStore(db),
    vault: new PostgresTokenVault(db, MASTER),
    executor,
    close: () => pg.close(),
  };
}

const BACKENDS = [memoryBackend, postgresBackend];

function activeGrant(id: string): Grant {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "gmail",
    email: "push@example.com",
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: now,
    updatedAt: now,
  };
}

function cached(grantId: string, providerMessageId: string, receivedMs: number): Message {
  const at = new Date(receivedMs).toISOString();
  return {
    id: `msg_${providerMessageId}`,
    grantId,
    providerMessageId,
    subject: `Subject ${providerMessageId}`,
    snippet: `Snippet ${providerMessageId}`,
    from: [{ email: "a@example.com" }],
    to: [{ email: "me@example.com" }],
    sentAt: at,
    receivedAt: at,
    folderIds: ["INBOX"],
    hasAttachments: false,
    body: { text: "x".repeat(2_000) },
  };
}

/** The pre-change algorithm: load everything, sort newest first, slice by offset. */
function referencePage(all: Message[], offset: number, limit: number) {
  const sorted = [...all].sort((a, b) => {
    const ta = Date.parse(a.receivedAt) || 0;
    const tb = Date.parse(b.receivedAt) || 0;
    if (tb !== ta) return tb - ta;
    return a.providerMessageId.localeCompare(b.providerMessageId);
  });
  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    ids: page.map((m) => m.id),
    nextCursor: nextOffset < sorted.length ? String(nextOffset) : undefined,
  };
}

// --- Fake Gmail -------------------------------------------------------------

let google: Server;
let tokenUrl = "";
let gmailApiBaseUrl = "";
/** History records returned by users.history.list. */
let historyRecords: unknown[] = [];
let profileHistoryId = "5000";
/** internalDate (ms) per message id served by messages.get. */
let internalDates: Record<string, number> = {};

before(async () => {
  google = createServer((req, res) => {
    const url = req.url ?? "/";
    req.resume();
    if (url.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ history: historyRecords, historyId: profileHistoryId }));
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/profile")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ emailAddress: "push@example.com", historyId: profileHistoryId }));
      return;
    }
    const match = url.match(/^\/gmail\/v1\/users\/me\/messages\/([^/?]+)/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          threadId: `thread-${id}`,
          labelIds: ["INBOX"],
          snippet: `Snippet ${id}`,
          internalDate: String(internalDates[id] ?? 1_710_000_000_000),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "To", value: "push@example.com" },
              { name: "Subject", value: `Subject ${id}` },
            ],
            body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
          },
        }),
      );
      return;
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
  historyRecords = [];
  profileHistoryId = "5000";
  internalDates = {};
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

function recordingWebhooks() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const bus = createWebhookBus({
    url: "http://127.0.0.1/hooks",
    secret: "whsec",
    fetchImpl: async (_url, init) => {
      const event = JSON.parse(String(init?.body ?? "{}")) as {
        type: string;
        data: Record<string, unknown>;
      };
      events.push({ type: event.type, data: event.data });
      return new Response(null, { status: 200 });
    },
    sleep: async () => {},
  });
  return { bus, events };
}

// --- Store list paging --------------------------------------------------------

for (const makeBackend of BACKENDS) {
  describe(`store-backed message list paging (${makeBackend === memoryBackend ? "memory" : "postgres"})`, () => {
    it("returns the same pages and cursors as the full-cache algorithm without a full read", async () => {
      const backend = await makeBackend();
      const { store, vault } = backend;
      const grant = activeGrant(`grant_paging_${backend.name}`);
      await store.putGrant(grant);
      await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });

      // Out-of-order inserts, plus ties on receivedAt to exercise the id tie-break.
      const base = 1_700_000_000_000;
      const all = [
        cached(grant.id, "m-03", base + 3_000),
        cached(grant.id, "m-01", base + 1_000),
        cached(grant.id, "m-07b", base + 7_000),
        cached(grant.id, "m-05", base + 5_000),
        cached(grant.id, "m-07a", base + 7_000),
        cached(grant.id, "m-02", base + 2_000),
        cached(grant.id, "m-09", base + 9_000),
      ];
      await store.upsertMessages(all.slice(0, 4));
      await store.upsertMessages(all.slice(4));

      const fullReads = countFullReads(store);
      const statementsBefore = backend.executor?.statements.length ?? 0;
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

      for (const limit of [1, 2, 3, 7, 25]) {
        let cursor: string | undefined;
        const walked: string[] = [];
        for (let guard = 0; guard < 20; guard += 1) {
          const offset = cursor ? Number(cursor) : 0;
          const query = `limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
          const res = await app.request(`/v1/grants/${grant.id}/messages?${query}`);
          assert.equal(res.status, 200);
          const body = (await res.json()) as {
            messages: Message[];
            nextCursor?: string;
            source?: string;
          };
          const expected = referencePage(all, offset, limit);
          assert.equal(body.source, "store");
          assert.deepEqual(body.messages.map((m) => m.id), expected.ids, `limit=${limit} offset=${offset}`);
          assert.equal(body.nextCursor, expected.nextCursor, `limit=${limit} offset=${offset}`);
          walked.push(...body.messages.map((m) => m.id));
          if (!body.nextCursor) break;
          cursor = body.nextCursor;
        }
        assert.deepEqual(walked, referencePage(all, 0, all.length).ids);
      }

      // Full payloads come back on each page (API response unchanged).
      const first = await app.request(`/v1/grants/${grant.id}/messages?limit=1`);
      const firstBody = (await first.json()) as { messages: Message[] };
      assert.deepEqual(firstBody.messages[0], all.find((m) => m.providerMessageId === "m-09"));

      // A cursor past the end answers an empty page without a next cursor.
      const past = await app.request(`/v1/grants/${grant.id}/messages?cursor=50`);
      const pastBody = (await past.json()) as { messages: Message[]; nextCursor?: string };
      assert.deepEqual(pastBody.messages, []);
      assert.equal(pastBody.nextCursor, undefined);

      assert.equal(fullReads.count(), 0, "store list must not load the whole cache");
      if (backend.executor) {
        const listed = backend.executor.statements.slice(statementsBefore);
        assert.deepEqual(unboundedPayloadReads(backend.executor), []);
        assert.ok(listed.some((sql) => /SELECT payload FROM messages .*LIMIT/i.test(sql)));
      }
      await backend.close();
    });
  });
}

// --- Gmail push ---------------------------------------------------------------

for (const makeBackend of BACKENDS) {
  describe(`Gmail push without full cache reads (${makeBackend === memoryBackend ? "memory" : "postgres"})`, () => {
    it("diffs new messages from the sync's own upserts and emits the same webhooks", async () => {
      const backend = await makeBackend();
      const { store, vault } = backend;
      const grant = activeGrant(`grant_push_${backend.name}`);
      await store.putGrant(grant);
      await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
      await store.putSyncCursor({
        grantId: grant.id,
        kind: "gmail_history",
        value: "4000",
        updatedAt: new Date().toISOString(),
      });
      const base = 1_700_000_000_000;
      await store.upsertMessages([
        cached(grant.id, "old-1", base + 1_000),
        cached(grant.id, "old-2", base + 2_000),
      ]);

      // A label change on a cached message plus two new messages (newest listed first).
      historyRecords = [
        { id: "4001", labelsAdded: [{ message: { id: "old-1" }, labelIds: ["STARRED"] }] },
        { id: "4002", messagesAdded: [{ message: { id: "new-late" } }] },
        { id: "4003", messagesAdded: [{ message: { id: "new-early" } }] },
      ];
      internalDates = {
        "old-1": base + 1_000,
        "new-early": base + 10_000,
        "new-late": base + 20_000,
      };
      profileHistoryId = "4003";

      const fullReads = countFullReads(store);
      const statementsBefore = backend.executor?.statements.length ?? 0;
      const { bus, events } = recordingWebhooks();

      const applied = await applyGmailPushNotification({
        store,
        vault,
        gmail: gmail(),
        webhooks: bus,
        notification: { emailAddress: "push@example.com", historyId: "4003" },
      });
      const pushSql = backend.executor?.statements.slice(statementsBefore) ?? [];

      assert.equal(applied.status, "ok");
      assert.deepEqual(applied.grantIds, [grant.id]);
      assert.equal(applied.results[0]?.mode, "incremental");
      assert.equal(applied.results[0]?.upserted, 3);
      // SyncResult keeps its shape: no message bodies ride along.
      assert.equal("upsertedMessages" in (applied.results[0] ?? {}), false);

      assert.deepEqual(
        events.map((e) => e.type),
        ["sync.completed", "message.created", "message.created"],
      );
      assert.deepEqual(events[0]?.data, {
        grantId: grant.id,
        tenantId: grant.tenantId,
        externalUserId: grant.externalUserId,
        provider: "gmail",
        mode: "incremental",
        historyId: "4003",
        upserted: 3,
        deleted: 0,
        source: "gmail_push",
      });
      const created = events.slice(1).map((e) => e.data);
      assert.deepEqual(
        created.map((d) => d.providerMessageId),
        ["new-early", "new-late"],
        "message.created only for messages absent before the sync, oldest first",
      );
      const stored = await store.listMessagesPage(grant.id, { offset: 0, limit: 25 });
      for (const data of created) {
        const row = stored.messages.find((m) => m.providerMessageId === data.providerMessageId);
        assert.ok(row);
        assert.deepEqual(data, {
          grantId: grant.id,
          tenantId: grant.tenantId,
          externalUserId: grant.externalUserId,
          provider: "gmail",
          messageId: row.id,
          providerMessageId: row.providerMessageId,
          threadId: row.threadId,
          subject: row.subject,
          receivedAt: row.receivedAt,
        });
      }

      assert.equal(fullReads.count(), 0, "push must not load the whole cache");
      if (backend.executor) {
        assert.deepEqual(
          pushSql.filter((sql) => /SELECT payload FROM messages/i.test(sql)),
          [],
          "push reads no message payloads at all",
        );
        assert.ok(pushSql.some((sql) => /SELECT provider_message_id FROM messages/i.test(sql)));
      }

      // A push that only touches labels emits sync.completed and no message.created.
      events.length = 0;
      historyRecords = [
        { id: "4004", labelsRemoved: [{ message: { id: "new-late" }, labelIds: ["UNREAD"] }] },
      ];
      profileHistoryId = "4004";
      await applyGmailPushNotification({
        store,
        vault,
        gmail: gmail(),
        webhooks: bus,
        notification: { emailAddress: "push@example.com", historyId: "4004" },
      });
      assert.deepEqual(events.map((e) => e.type), ["sync.completed"]);
      assert.equal(events[0]?.data.upserted, 1);
      assert.equal(fullReads.count(), 0);

      await backend.close();
    });
  });
}
