import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant } from "@inboxlink/core";
import { resetAccessTokenCacheForTests } from "./access-token-cache.js";
import { createStoreSyncQueue, drainSyncJobs } from "./queue/sync-queue.js";
import { createApp } from "./routes/app.js";
import { parsePubSubPushBody } from "./sync/gmail-push.js";
import { startOrRenewGmailWatch } from "./sync/gmail-watch.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import { createWebhookBus } from "./webhooks/deliver.js";

const REFRESH = "1//vaulted-refresh-for-wave-d";
const ACCESS = "ya29.wave-d-access";
const MASTER = "test-master-key-at-least-16";
const PUSH_SECRET = "push-secret-for-tests";
const CRON_SECRET = "cron-secret-for-tests";
const TOPIC = "projects/test/topics/gmail-push";

const plain = Buffer.from("Wave D body").toString("base64url");

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
let watchCalls = 0;
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
    const body = await readBody(req);
    hits.push({ method: req.method ?? "GET", url });

    if (url.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/watch") && req.method === "POST") {
      watchCalls += 1;
      const parsed = JSON.parse(body) as { topicName?: string };
      assert.equal(parsed.topicName, TOPIC);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          historyId: profileHistoryId,
          expiration: String(Date.now() + 6 * 24 * 60 * 60_000),
        }),
      );
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
        res.end(JSON.stringify({ error: { code: historyStatus } }));
        return;
      }
      res.end(JSON.stringify({ history: [], historyId: profileHistoryId }));
      return;
    }

    if (url.startsWith("/gmail/v1/users/me/messages?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: listIds.map((id) => ({ id })) }));
      return;
    }

    const msgMatch = url.match(/^\/gmail\/v1\/users\/me\/messages\/([^/?]+)/);
    if (msgMatch) {
      const id = decodeURIComponent(msgMatch[1]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messageResource(id, `Subject ${id}`)));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const addr = google.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  tokenUrl = `http://127.0.0.1:${addr.port}/token`;
  gmailApiBaseUrl = `http://127.0.0.1:${addr.port}/gmail/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => google.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetAccessTokenCacheForTests();
  hits = [];
  historyStatus = 200;
  profileHistoryId = "9000";
  listIds = ["msg-a"];
  watchCalls = 0;
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

function activeGrant(id = "grant_wave_d"): Grant {
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

describe("parsePubSubPushBody", () => {
  it("decodes base64 Pub/Sub envelope", () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: "me@example.com", historyId: "99" }),
    ).toString("base64");
    const parsed = parsePubSubPushBody({ message: { data }, subscription: "projects/x/subscriptions/y" });
    assert.equal(parsed?.emailAddress, "me@example.com");
    assert.equal(parsed?.historyId, "99");
  });

  it("accepts raw notification JSON", () => {
    const parsed = parsePubSubPushBody({ emailAddress: "a@b.com", historyId: "1" });
    assert.equal(parsed?.emailAddress, "a@b.com");
  });
});

describe("Wave D Gmail watch + push + async jobs", () => {
  it("starts a watch and stores expiration on the sync cursor", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_watch");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });

    const result = await startOrRenewGmailWatch({
      store,
      vault,
      gmail: gmail(),
      grant,
      topicName: TOPIC,
    });
    assert.equal(result.status, "ok");
    assert.equal(watchCalls, 1);
    const cursor = await store.getSyncCursor(grant.id);
    assert.ok(cursor?.watchExpiration);
    assert.ok(cursor?.value);
  });

  it("applies Pub/Sub push via history sync and emits message.created", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_push");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "8000",
      updatedAt: new Date().toISOString(),
    });

    // Seed empty history then force bootstrap path via 404 → new message.
    historyStatus = 404;
    listIds = ["push-new"];
    profileHistoryId = "9100";

    const deliveries: Array<{ type: string; body: string }> = [];
    const webhooks = createWebhookBus({
      url: "http://127.0.0.1/hooks",
      secret: "whsec",
      fetchImpl: async (_url, init) => {
        deliveries.push({
          type: String((init?.headers as Record<string, string>)?.["X-InboxLink-Event"] ?? ""),
          body: String(init?.body ?? ""),
        });
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
    });

    const app = createApp({
      store,
      vault,
      gmail: gmail(),
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      queue: createStoreSyncQueue(store),
      webhooks,
      gmailPubsubTopic: TOPIC,
      gmailPushSecret: PUSH_SECRET,
      cronSecret: CRON_SECRET,
    });

    const data = Buffer.from(
      JSON.stringify({ emailAddress: "me@example.com", historyId: "9100" }),
    ).toString("base64");
    const res = await app.request(`/v1/internal/gmail/push?token=${PUSH_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { data } }),
    });
    assert.equal(res.status, 204);

    const messages = await store.listMessages(grant.id);
    assert.ok(messages.some((m) => m.providerMessageId === "push-new"));
    assert.ok(deliveries.some((d) => d.type === "sync.completed"));
    assert.ok(deliveries.some((d) => d.type === "message.created"));
  });

  it("rejects push without secret and renew cron without CRON_SECRET", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const app = createApp({
      store,
      vault,
      gmail: gmail(),
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      queue: null,
      gmailPushSecret: PUSH_SECRET,
      cronSecret: CRON_SECRET,
      gmailPubsubTopic: TOPIC,
    });

    const badPush = await app.request("/v1/internal/gmail/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailAddress: "me@example.com" }),
    });
    assert.equal(badPush.status, 401);

    const badCron = await app.request("/v1/internal/cron/renew-gmail-watches", { method: "POST" });
    assert.equal(badCron.status, 401);

    const grant = activeGrant("grant_renew");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });

    const okCron = await app.request("/v1/internal/cron/renew-gmail-watches", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    assert.equal(okCron.status, 200);
    const body = (await okCron.json()) as { renewed: number };
    assert.equal(body.renewed, 1);
    assert.equal(watchCalls, 1);
  });

  it("drains sync jobs via cron endpoint", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_drain");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    listIds = ["drain-1"];
    profileHistoryId = "10001";

    const app = createApp({
      store,
      vault,
      gmail: gmail(),
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      queue: createStoreSyncQueue(store),
      cronSecret: CRON_SECRET,
    });

    // Enqueue without relying on deferred drain completing first.
    const job = await store.enqueueSyncJob({
      grantId: grant.id,
      tenantId: grant.tenantId,
      kind: "bootstrap",
      forceBootstrap: true,
    });
    assert.equal(job.status, "queued");

    const res = await app.request("/v1/internal/cron/drain-sync-jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { processed: number; completed: number };
    assert.ok(body.processed >= 1);
    assert.ok(body.completed >= 1);
    const done = await store.getSyncJob(job.id);
    assert.equal(done?.status, "completed");
  });

  it("history 404 on push re-bootstraps without crashing", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_push_404");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "expired",
      updatedAt: new Date().toISOString(),
    });
    historyStatus = 404;
    listIds = ["after-404"];
    profileHistoryId = "12000";

    const app = createApp({
      store,
      vault,
      gmail: gmail(),
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      queue: null,
      gmailPushSecret: PUSH_SECRET,
    });

    const res = await app.request("/v1/internal/gmail/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inboxlink-push-secret": PUSH_SECRET,
      },
      body: JSON.stringify({ emailAddress: "me@example.com", historyId: "12000" }),
    });
    assert.equal(res.status, 204);
    const messages = await store.listMessages(grant.id);
    assert.ok(messages.some((m) => m.providerMessageId === "after-404"));
    assert.equal((await store.getSyncCursor(grant.id))?.value, "12000");
  });
});

describe("drainSyncJobs unit", () => {
  it("no-ops when queue empty", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const result = await drainSyncJobs({ store, vault, gmail: gmail(), limit: 2 });
    assert.deepEqual(result, { processed: 0, completed: 0, failed: 0 });
  });
});
