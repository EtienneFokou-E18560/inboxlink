import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant, Message } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import type { SqlExecutor } from "./db/sql.js";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const REFRESH = "1//vaulted-refresh-for-sync";
const ACCESS = "ya29.sync-access-token";
const MASTER = "test-master-key-at-least-16";

const plain = Buffer.from("Synced body").toString("base64url");

function messageResource(id: string, subject: string) {
  return {
    id,
    threadId: id,
    labelIds: ["INBOX"],
    snippet: subject,
    internalDate: "1710000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Tue, 10 Mar 2026 12:00:00 +0000" },
      ],
      body: { data: plain },
    },
  };
}

type Hit = { method: string; url: string };

let hits: Hit[] = [];
let historyStatus = 200;
let profileHistoryId = "9000";
let listIds: string[] = ["msg-a"];
let historyPages: Array<{
  history?: unknown[];
  nextPageToken?: string;
  historyId: string;
}> = [];
let google: Server;
let tokenUrl = "";
let gmailApiBaseUrl = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

before(async () => {
  google = createServer(async (req, res) => {
    const url = req.url ?? "/";
    await readBody(req);
    hits.push({ method: req.method ?? "GET", url });

    if (url.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/profile")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ emailAddress: "me@example.com", historyId: profileHistoryId }));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/history")) {
      res.writeHead(historyStatus, { "content-type": "application/json" });
      if (historyStatus !== 200) {
        res.end(JSON.stringify({ error: { code: historyStatus, message: "notFound" } }));
        return;
      }
      const pageToken = new URL(url, "http://gmail.local").searchParams.get("pageToken");
      const page =
        historyPages.find((candidate, index) =>
          pageToken ? candidate.nextPageToken === undefined && index > 0 : index === 0,
        ) ??
        historyPages[0] ?? { history: [], historyId: profileHistoryId };
      // Prefer page matching pageToken when present
      const selected = pageToken
        ? historyPages.find((p, i) => i > 0) ?? page
        : historyPages[0] ?? page;
      res.end(JSON.stringify(selected));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/messages/")) {
      const id = decodeURIComponent(url.split("/messages/")[1]!.split("?")[0]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messageResource(id, `Subject ${id}`)));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: listIds.map((id) => ({ id })) }));
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
  await new Promise<void>((resolve, reject) => {
    google.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  resetAccessTokenCacheForTests();
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

function activeGrant(id = "grant_sync"): Grant {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "gmail",
    email: "me@example.com",
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: now,
    updatedAt: now,
  };
}

function appFor(store: MemoryStore | PostgresStore, vault: MemoryTokenVault | PostgresTokenVault) {
  return createApp({
    store,
    vault,
    gmail: gmail(),
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "unused",
    mode: "single",
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    queue: null,
  });
}

async function sealGrant(
  store: MemoryStore | PostgresStore,
  vault: MemoryTokenVault | PostgresTokenVault,
  grant: Grant,
) {
  await store.putGrant(grant);
  await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
}

function resetGmail() {
  hits = [];
  historyStatus = 200;
  profileHistoryId = "9000";
  listIds = ["msg-a"];
  historyPages = [{ history: [], historyId: "9000" }];
}

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}
  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(text, params);
    return result.rows ?? [];
  }
  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}

describe("Gmail history sync watermark", () => {
  it("bootstraps messages and persists a historyId watermark", async () => {
    resetGmail();
    listIds = ["msg-a", "msg-b"];
    profileHistoryId = "10001";
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_bootstrap");
    await sealGrant(store, vault, grant);
    const app = appFor(store, vault);

    const res = await app.request(`/v1/grants/${grant.id}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      mode: string;
      historyId: string;
      upserted: number;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.mode, "bootstrap");
    assert.equal(body.historyId, "10001");
    assert.equal(body.upserted, 2);

    const cursor = await store.getSyncCursor(grant.id);
    assert.equal(cursor?.kind, "gmail_history");
    assert.equal(cursor?.value, "10001");
    const cached = await store.listMessages(grant.id);
    assert.equal(cached.length, 2);
    assert.ok(hits.some((hit) => hit.url.startsWith("/gmail/v1/users/me/profile")));
    assert.ok(hits.some((hit) => hit.url.startsWith("/gmail/v1/users/me/messages?")));
  });

  it("applies incremental history.list adds and deletes idempotently", async () => {
    resetGmail();
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_incremental");
    await sealGrant(store, vault, grant);
    await store.upsertMessages([
      {
        id: "msg_old-1",
        grantId: grant.id,
        providerMessageId: "old-1",
        subject: "Keep me",
        snippet: "Keep me",
        from: [{ email: "a@example.com" }],
        to: [{ email: "me@example.com" }],
        sentAt: new Date(0).toISOString(),
        receivedAt: new Date(0).toISOString(),
        folderIds: ["INBOX"],
        hasAttachments: false,
      } satisfies Message,
      {
        id: "msg_gone-1",
        grantId: grant.id,
        providerMessageId: "gone-1",
        subject: "Delete me",
        snippet: "Delete me",
        from: [{ email: "a@example.com" }],
        to: [{ email: "me@example.com" }],
        sentAt: new Date(0).toISOString(),
        receivedAt: new Date(0).toISOString(),
        folderIds: ["INBOX"],
        hasAttachments: false,
      } satisfies Message,
    ]);
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "5000",
      updatedAt: new Date().toISOString(),
    });
    historyPages = [
      {
        historyId: "7000",
        history: [
          {
            id: "5001",
            messagesAdded: [{ message: { id: "new-1" } }],
            messagesDeleted: [{ message: { id: "gone-1" } }],
          },
        ],
      },
    ];

    const app = appFor(store, vault);
    const first = await app.request(`/v1/grants/${grant.id}/sync`, { method: "POST" });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      mode: string;
      historyId: string;
      upserted: number;
      deleted: number;
    };
    assert.equal(firstBody.mode, "incremental");
    assert.equal(firstBody.historyId, "7000");
    assert.equal(firstBody.upserted, 1);
    assert.equal(firstBody.deleted, 1);

    const after = await store.listMessages(grant.id);
    assert.equal(after.length, 2);
    assert.ok(after.some((m) => m.providerMessageId === "old-1"));
    assert.ok(after.some((m) => m.providerMessageId === "new-1"));
    assert.ok(!after.some((m) => m.providerMessageId === "gone-1"));
    assert.equal((await store.getSyncCursor(grant.id))?.value, "7000");

    // Second sync with empty history is idempotent.
    historyPages = [{ history: [], historyId: "7000" }];
    hits = [];
    const second = await app.request(`/v1/grants/${grant.id}/sync`, { method: "POST" });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { upserted: number; deleted: number; mode: string };
    assert.equal(secondBody.mode, "incremental");
    assert.equal(secondBody.upserted, 0);
    assert.equal(secondBody.deleted, 0);
    assert.ok(hits.some((hit) => hit.url.includes("/history?")));
  });

  it("falls back to bootstrap when historyId returns 404", async () => {
    resetGmail();
    historyStatus = 404;
    listIds = ["fresh-1"];
    profileHistoryId = "12000";
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_gap");
    await sealGrant(store, vault, grant);
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "stale-watermark",
      updatedAt: new Date().toISOString(),
    });
    await store.upsertMessages([
      {
        id: "msg_stale",
        grantId: grant.id,
        providerMessageId: "stale",
        subject: "stale",
        snippet: "stale",
        from: [],
        to: [],
        sentAt: new Date(0).toISOString(),
        receivedAt: new Date(0).toISOString(),
        folderIds: [],
        hasAttachments: false,
      },
    ]);

    const app = appFor(store, vault);
    const res = await app.request(`/v1/grants/${grant.id}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { mode: string; historyId: string; upserted: number };
    assert.equal(body.mode, "bootstrap");
    assert.equal(body.historyId, "12000");
    assert.equal(body.upserted, 1);
    const cached = await store.listMessages(grant.id);
    assert.equal(cached.length, 1);
    assert.equal(cached[0]?.providerMessageId, "fresh-1");
  });

  it("persists cursors and upserts across Postgres store instances", async () => {
    resetGmail();
    listIds = ["pg-1"];
    profileHistoryId = "33000";
    const pglite = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pglite));
    const storeA = new PostgresStore(db);
    const storeB = new PostgresStore(db);
    const vault = new PostgresTokenVault(db, MASTER);
    const grant = activeGrant("grant_pg_sync");
    await sealGrant(storeA, vault, grant);

    const app = appFor(storeA, vault);
    const res = await app.request(`/v1/grants/${grant.id}/sync`, { method: "POST" });
    assert.equal(res.status, 200);

    const cursor = await storeB.getSyncCursor(grant.id);
    assert.equal(cursor?.value, "33000");
    const messages = await storeB.listMessages(grant.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.providerMessageId, "pg-1");

    // Idempotent upsert of the same provider id.
    await storeB.upsertMessages(messages);
    assert.equal((await storeB.listMessages(grant.id)).length, 1);
  });
});
