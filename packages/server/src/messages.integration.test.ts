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

const REFRESH = "1//vaulted-refresh-token-not-for-clients";
const ACCESS = "ya29.message-access-token";
const MASTER = "test-master-key-at-least-16";

const plain = Buffer.from("Hello from Ada").toString("base64url");
const html = Buffer.from("<p>Hello from Ada</p>").toString("base64url");

function gmailResource() {
  return {
    id: "18c1abc",
    threadId: "18c1abc",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    snippet: "Hello from Ada",
    internalDate: "1710000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: '"Lovelace, Ada" <ada@example.com>' },
        { name: "To", value: "etiennefk@gmail.com" },
        { name: "Cc", value: "Grace Hopper <grace@example.com>" },
        { name: "Subject", value: "Normalized hello" },
        { name: "Date", value: "Tue, 10 Mar 2026 12:00:00 +0000" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: plain } },
            { mimeType: "text/html", body: { data: html } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "notes.pdf",
          body: { attachmentId: "att-1", size: 2048 },
        },
        {
          mimeType: "image/png",
          filename: "diagram.png",
          body: { attachmentId: "att-2", size: 512 },
        },
      ],
    },
  };
}

/** Gmail `format=metadata` — headers only, no MIME body parts. */
function gmailMetadataResource() {
  const full = gmailResource();
  return {
    id: full.id,
    threadId: full.threadId,
    labelIds: full.labelIds,
    snippet: full.snippet,
    internalDate: full.internalDate,
    payload: {
      mimeType: "multipart/mixed",
      headers: full.payload.headers,
    },
  };
}

type Hit = { method: string; url: string; body: string };

let hits: Hit[] = [];
let refreshStatus = 200;
let listStatus = 200;
let getStatus = 200;
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
    hits.push({ method: req.method ?? "GET", url, body });
    if (url.startsWith("/token")) {
      res.writeHead(refreshStatus, { "content-type": "application/json" });
      if (refreshStatus !== 200) {
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/messages/")) {
      const pathId = decodeURIComponent(url.split("?")[0]?.split("/").pop() ?? "");
      if (getStatus !== 200) {
        res.writeHead(getStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: getStatus } }));
        return;
      }
      if (pathId !== "18c1abc") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: 404 } }));
        return;
      }
      const format = new URL(url, "http://gmail.local").searchParams.get("format") ?? "full";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(format === "metadata" ? gmailMetadataResource() : gmailResource()));
      return;
    }
    if (url.startsWith("/gmail/v1/users/me/messages")) {
      res.writeHead(listStatus, { "content-type": "application/json" });
      if (listStatus !== 200) {
        res.end(JSON.stringify({ error: { code: listStatus } }));
        return;
      }
      const page = new URL(url, "http://gmail.local").searchParams.get("pageToken");
      res.end(
        JSON.stringify({
          messages: [{ id: "18c1abc" }],
          nextPageToken: page ? undefined : "page-2",
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

function activeGrant(id = "grant_messages"): Grant {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "gmail",
    email: "etiennefk@gmail.com",
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: now,
    updatedAt: now,
  };
}

function appFor(store: MemoryStore | PostgresStore, vault: MemoryTokenVault | PostgresTokenVault, mode: "single" | "multi" = "single") {
  return createApp({
    store,
    vault,
    gmail: gmail(),
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "tenant-api-key-test",
    mode,
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    queue: null,
    rateLimiter: null,
  });
}

describe("Gmail message list", () => {
  it("requires the tenant API key in multi mode", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const app = appFor(store, vault, "multi");
    const denied = await app.request("/v1/grants/grant_missing/messages");
    assert.equal(denied.status, 401);
  });

  it("defaults to the synced store cache without calling Gmail", async () => {
    hits = [];
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant();
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const older: Message = {
      id: "msg_old",
      grantId: grant.id,
      providerMessageId: "old",
      subject: "Older",
      snippet: "Older",
      from: [{ email: "a@example.com" }],
      to: [{ email: "me@example.com" }],
      sentAt: new Date(1_700_000_000_000).toISOString(),
      receivedAt: new Date(1_700_000_000_000).toISOString(),
      folderIds: ["INBOX"],
      hasAttachments: false,
    };
    const newer: Message = {
      id: "msg_18c1abc",
      grantId: grant.id,
      providerMessageId: "18c1abc",
      subject: "Normalized hello",
      snippet: "Hello from Ada",
      from: [{ name: "Lovelace, Ada", email: "ada@example.com" }],
      to: [{ email: "etiennefk@gmail.com" }],
      cc: [{ name: "Grace Hopper", email: "grace@example.com" }],
      sentAt: new Date(1_710_000_000_000).toISOString(),
      receivedAt: new Date(1_710_000_000_000).toISOString(),
      folderIds: ["INBOX", "CATEGORY_PERSONAL"],
      labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
      hasAttachments: false,
    };
    await store.upsertMessages([older, newer]);
    await store.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "hist-42",
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
    const app = appFor(store, vault);

    const missing = await app.request("/v1/grants/grant_missing/messages");
    assert.equal(missing.status, 404);

    const listed = await app.request(`/v1/grants/${grant.id}/messages?limit=1`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      messages: Message[];
      nextCursor?: string;
      source?: string;
      syncedAt?: string;
      historyId?: string;
    };
    assert.equal(body.source, "store");
    assert.equal(body.syncedAt, "2026-03-10T12:00:00.000Z");
    assert.equal(body.historyId, "hist-42");
    assert.equal(body.nextCursor, "1");
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]?.id, "msg_18c1abc");
    assert.equal(body.messages[0]?.subject, "Normalized hello");
    assert.equal(hits.length, 0);

    const page2 = await app.request(`/v1/grants/${grant.id}/messages?limit=1&cursor=1`);
    assert.equal(page2.status, 200);
    const body2 = (await page2.json()) as { messages: Message[]; nextCursor?: string };
    assert.equal(body2.messages[0]?.id, "msg_old");
    assert.equal(body2.nextCursor, undefined);

    const empty = await app.request(`/v1/grants/${activeGrant("grant_empty").id}/messages`);
    assert.equal(empty.status, 404);
  });

  it("lists live Gmail with source=live using the vaulted refresh token", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_live");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const listed = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&limit=5&cursor=page-2`,
    );
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      messages: Message[];
      nextCursor?: string;
      source?: string;
    };
    assert.equal(body.source, "live");
    assert.equal(body.nextCursor, undefined);
    assert.equal(body.messages.length, 1);
    const message = body.messages[0];
    assert.ok(message);
    assert.equal(message.id, "msg_18c1abc");
    assert.equal(message.grantId, grant.id);
    assert.equal(message.providerMessageId, "18c1abc");
    assert.equal(message.subject, "Normalized hello");
    assert.equal(message.hasAttachments, false);
    assert.equal(message.body, undefined);

    const raw = JSON.stringify(body);
    assert.equal(raw.includes(REFRESH), false);
    assert.equal(raw.includes(ACCESS), false);

    const refresh = hits.find((hit) => hit.url.startsWith("/token"));
    assert.ok(refresh);
    const refreshBody = new URLSearchParams(refresh.body);
    assert.equal(refreshBody.get("grant_type"), "refresh_token");
    assert.equal(refreshBody.get("refresh_token"), REFRESH);
    const list = hits.find((hit) => hit.url.startsWith("/gmail/v1/users/me/messages?"));
    assert.ok(list);
    const listUrl = new URL(list.url, "http://gmail.local");
    assert.equal(listUrl.searchParams.get("maxResults"), "5");
    assert.equal(listUrl.searchParams.get("pageToken"), "page-2");
    const fetched = hits.find((hit) => hit.url.includes("/messages/18c1abc"));
    assert.ok(fetched);
    const fetchedUrl = new URL(fetched.url, "http://gmail.local");
    assert.equal(fetchedUrl.searchParams.get("format"), "metadata");

    const again = await app.request(`/v1/grants/${grant.id}/messages?source=live`);
    const firstPage = (await again.json()) as { nextCursor?: string };
    assert.equal(firstPage.nextCursor, "page-2");
  });

  it("does not call Gmail for an inactive grant and marks a rejected refresh on live", async () => {
    hits = [];
    refreshStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_revoked");
    grant.status = "revoked";
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);
    const inactive = await app.request(`/v1/grants/${grant.id}/messages`);
    assert.equal(inactive.status, 409);
    assert.equal(((await inactive.json()) as { error: string }).error, "grant_inactive");
    assert.equal(hits.length, 0);

    const live = activeGrant("grant_reauth");
    await store.putGrant(live);
    await vault.seal(REFRESH, { grantId: live.id, tenantId: live.tenantId });
    refreshStatus = 400;
    const rejected = await app.request(`/v1/grants/${live.id}/messages?source=live`);
    assert.equal(rejected.status, 409);
    const rejectedBody = (await rejected.json()) as { error: string; guidance?: string };
    assert.equal(rejectedBody.error, "needs_reauth");
    assert.match(rejectedBody.guidance ?? "", /Connect/);
    assert.equal((await store.getGrant(live.id))?.status, "needs_reauth");
    assert.equal(JSON.stringify(rejectedBody).includes(REFRESH), false);

    const bare = activeGrant("grant_no_token");
    await store.putGrant(bare);
    const before = hits.length;
    // Store list does not require a refresh token.
    const storeList = await app.request(`/v1/grants/${bare.id}/messages`);
    assert.equal(storeList.status, 200);
    assert.equal(((await storeList.json()) as { messages: Message[] }).messages.length, 0);
    assert.equal(hits.length, before);

    const missingToken = await app.request(`/v1/grants/${bare.id}/messages?source=live`);
    assert.equal(missingToken.status, 409);
    assert.equal(((await missingToken.json()) as { error: string }).error, "missing_refresh_token");
    assert.equal(hits.length, before);

    const badLimit = await app.request(`/v1/grants/${bare.id}/messages?limit=99`);
    assert.equal(badLimit.status, 400);

    const badSource = await app.request(`/v1/grants/${bare.id}/messages?source=redis`);
    assert.equal(badSource.status, 400);
    assert.equal(((await badSource.json()) as { error: string }).error, "invalid_source");
  });

  it("forwards Gmail q, label, and structured filters on source=live", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_filters");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const listed = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&limit=3&q=${encodeURIComponent("is:unread")}&from=${encodeURIComponent("ada@example.com")}&label=INBOX&label=UNREAD&includeSpamTrash=true`,
    );
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { messages: Message[]; source?: string };
    assert.equal(body.source, "live");
    assert.equal(body.messages.length, 1);

    const list = hits.find((hit) => hit.url.startsWith("/gmail/v1/users/me/messages?"));
    assert.ok(list);
    const listUrl = new URL(list.url, "http://gmail.local");
    assert.equal(listUrl.searchParams.get("maxResults"), "3");
    assert.equal(listUrl.searchParams.get("q"), "is:unread from:ada@example.com");
    assert.deepEqual(listUrl.searchParams.getAll("labelIds"), ["INBOX", "UNREAD"]);
    assert.equal(listUrl.searchParams.get("includeSpamTrash"), "true");
    assert.equal(JSON.stringify(body).includes(REFRESH), false);
  });

  it("rejects invalid filter query params on source=live without calling Gmail", async () => {
    hits = [];
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_bad_filters");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const badLabel = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&label=bad%20label`,
    );
    assert.equal(badLabel.status, 400);
    assert.equal(((await badLabel.json()) as { error: string }).error, "invalid_label");

    const badSpam = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&includeSpamTrash=maybe`,
    );
    assert.equal(badSpam.status, 400);
    assert.equal(((await badSpam.json()) as { error: string }).error, "invalid_include_spam_trash");

    assert.equal(hits.length, 0);
  });

  it("applies message filters in multi mode with a Bearer secret on source=live", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_multi_filters");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault, "multi");

    const denied = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&subject=${encodeURIComponent("Normalized hello")}`,
    );
    assert.equal(denied.status, 401);

    const listed = await app.request(
      `/v1/grants/${grant.id}/messages?source=live&subject=${encodeURIComponent("Normalized hello")}&label=INBOX`,
      { headers: { authorization: "Bearer tenant-api-key-test" } },
    );
    assert.equal(listed.status, 200);
    const list = hits.find((hit) => hit.url.startsWith("/gmail/v1/users/me/messages?"));
    assert.ok(list);
    const listUrl = new URL(list.url, "http://gmail.local");
    assert.equal(listUrl.searchParams.get("q"), 'subject:"Normalized hello"');
    assert.deepEqual(listUrl.searchParams.getAll("labelIds"), ["INBOX"]);
  });

  it("reads the refresh token sealed on another Postgres instance for source=live", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    getStatus = 200;
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const storeA = new PostgresStore(db);
    const storeB = new PostgresStore(db);
    const vaultA = new PostgresTokenVault(db, MASTER);
    const vaultB = new PostgresTokenVault(db, MASTER);
    const grant = activeGrant("grant_shared");
    await storeA.putGrant(grant);
    await vaultA.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const appB = appFor(storeB, vaultB);
    const listed = await appB.request(`/v1/grants/${grant.id}/messages?source=live&limit=1`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { messages: Message[] };
    assert.equal(body.messages[0]?.subject, "Normalized hello");
    assert.equal(JSON.stringify(body).includes(REFRESH), false);
    assert.ok(await vaultB.getCiphertext(grant.id));
    await pg.close();
  });

  it("lists store-backed messages across Postgres store instances", async () => {
    hits = [];
    const pg = new PGlite();
    const db = new PgDatabase(new PgliteExecutor(pg));
    const storeA = new PostgresStore(db);
    const storeB = new PostgresStore(db);
    const vault = new PostgresTokenVault(db, MASTER);
    const grant = activeGrant("grant_pg_store_list");
    await storeA.putGrant(grant);
    await storeA.upsertMessages([
      {
        id: "msg_pg",
        grantId: grant.id,
        providerMessageId: "pg-1",
        subject: "From store",
        snippet: "From store",
        from: [{ email: "a@example.com" }],
        to: [{ email: "me@example.com" }],
        sentAt: new Date(0).toISOString(),
        receivedAt: new Date(0).toISOString(),
        folderIds: ["INBOX"],
        hasAttachments: false,
      },
    ]);
    await storeA.putSyncCursor({
      grantId: grant.id,
      kind: "gmail_history",
      value: "pg-hist",
      updatedAt: "2026-03-11T00:00:00.000Z",
    });
    const app = appFor(storeB, vault);
    const listed = await app.request(`/v1/grants/${grant.id}/messages`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      messages: Message[];
      source?: string;
      historyId?: string;
    };
    assert.equal(body.source, "store");
    assert.equal(body.historyId, "pg-hist");
    assert.equal(body.messages[0]?.subject, "From store");
    assert.equal(hits.length, 0);
    await pg.close();
  });
});

describe("Gmail message get-by-id", () => {
  it("returns one normalized message with attachment metadata", async () => {
    hits = [];
    refreshStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_get");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const byInboxId = await app.request(`/v1/grants/${grant.id}/messages/msg_18c1abc`);
    assert.equal(byInboxId.status, 200);
    const wrapped = (await byInboxId.json()) as { message: Message };
    const message = wrapped.message;
    assert.equal(message.id, "msg_18c1abc");
    assert.equal(message.providerMessageId, "18c1abc");
    assert.equal(message.subject, "Normalized hello");
    assert.equal(message.hasAttachments, true);
    assert.deepEqual(message.attachments, [
      { id: "att-1", filename: "notes.pdf", mimeType: "application/pdf", size: 2048 },
      { id: "att-2", filename: "diagram.png", mimeType: "image/png", size: 512 },
    ]);
    assert.equal(message.body?.text, "Hello from Ada");
    assert.equal(JSON.stringify(wrapped).includes(REFRESH), false);
    assert.equal(JSON.stringify(wrapped).includes(ACCESS), false);

    const byProviderId = await app.request(`/v1/grants/${grant.id}/messages/18c1abc`);
    assert.equal(byProviderId.status, 200);
    assert.equal(((await byProviderId.json()) as { message: Message }).message.id, "msg_18c1abc");

    const getHit = hits.find((hit) => hit.url.includes("/messages/18c1abc"));
    assert.ok(getHit);
    assert.equal(new URL(getHit.url, "http://gmail.local").searchParams.get("format"), "full");
    assert.equal(hits.some((hit) => hit.url.includes("/attachments/")), false);
  });

  it("maps missing messages and inactive grants without leaking tokens", async () => {
    hits = [];
    refreshStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_get_errors");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const missing = await app.request(`/v1/grants/${grant.id}/messages/msg_does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: string }).error, "not_found");

    getStatus = 404;
    const gmail404 = await app.request(`/v1/grants/${grant.id}/messages/18c1abc`);
    assert.equal(gmail404.status, 404);

    const badId = await app.request(`/v1/grants/${grant.id}/messages/msg_`);
    assert.equal(badId.status, 400);
    assert.equal(((await badId.json()) as { error: string }).error, "invalid_message_id");

    const inactive = activeGrant("grant_get_inactive");
    inactive.status = "needs_reauth";
    await store.putGrant(inactive);
    await vault.seal(REFRESH, { grantId: inactive.id, tenantId: inactive.tenantId });
    const before = hits.length;
    const blocked = await app.request(`/v1/grants/${inactive.id}/messages/msg_18c1abc`);
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as { error: string }).error, "grant_inactive");
    assert.equal(hits.length, before);

    const unknownGrant = await app.request("/v1/grants/grant_missing/messages/msg_18c1abc");
    assert.equal(unknownGrant.status, 404);
  });

  it("refreshes the access token once across live list and get for the same grant", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    getStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_cache_hit");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    const listed = await app.request(`/v1/grants/${grant.id}/messages?source=live&limit=1`);
    assert.equal(listed.status, 200);
    const got = await app.request(`/v1/grants/${grant.id}/messages/msg_18c1abc`);
    assert.equal(got.status, 200);
    const listedAgain = await app.request(`/v1/grants/${grant.id}/messages?source=live&limit=1`);
    assert.equal(listedAgain.status, 200);

    const tokenHits = hits.filter((hit) => hit.url.startsWith("/token"));
    assert.equal(tokenHits.length, 1);
    assert.ok(hits.some((hit) => hit.url.includes("/messages/18c1abc") && hit.url.includes("format=full")));
  });

  it("invalidates the cached access token when the grant is deleted", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const grant = activeGrant("grant_cache_revoke");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault);

    assert.equal(
      (await app.request(`/v1/grants/${grant.id}/messages?source=live&limit=1`)).status,
      200,
    );
    assert.equal(hits.filter((h) => h.url.startsWith("/token")).length, 1);

    const del = await app.request(`/v1/grants/${grant.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);

    // Recreate grant + vault entry under the same id (new Connect).
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    hits = [];
    assert.equal(
      (await app.request(`/v1/grants/${grant.id}/messages?source=live&limit=1`)).status,
      200,
    );
    assert.equal(hits.filter((h) => h.url.startsWith("/token")).length, 1);
  });
});

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly db: PGlite) {}

  async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(text, params);
    return result.rows;
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }
}
