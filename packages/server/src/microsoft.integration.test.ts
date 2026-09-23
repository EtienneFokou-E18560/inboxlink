import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { MicrosoftAdapter } from "@inboxlink/adapters-microsoft";
import type { Grant, Message } from "@inboxlink/core";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const API_SECRET = "tenant-api-key-test";
const REFRESH = "M.R3_BAY.-vaulted-microsoft-refresh";
const ACCESS = "EwBwA8l6BAAU-ms-access-token";
const EMAIL = "ada@outlook.com";
const MASTER = "test-master-key-at-least-16";

type Hit = { method: string; url: string; body: string };

let hits: Hit[] = [];
let refreshStatus = 200;
let listStatus = 200;
let ms: Server;
let tokenUrl = "";
let graphBaseUrl = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function graphMessage() {
  return {
    id: "AAMkAGI2TG93AAA=",
    conversationId: "AAQkAGI2Conversation=",
    subject: "Graph normalized hello",
    bodyPreview: "Hello from Graph",
    from: { emailAddress: { name: "Lovelace, Ada", address: "ada@example.com" } },
    toRecipients: [{ emailAddress: { address: EMAIL } }],
    ccRecipients: [{ emailAddress: { name: "Grace Hopper", address: "grace@example.com" } }],
    sentDateTime: "2026-03-10T12:00:00Z",
    receivedDateTime: "2026-03-10T12:01:00Z",
    parentFolderId: "AQMkAGI2AAAA=",
    hasAttachments: true,
    categories: ["Blue category"],
    body: { contentType: "html", content: "<p>Hello from Graph</p>" },
  };
}

before(async () => {
  ms = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const body = await readBody(req);
    hits.push({ method: req.method ?? "GET", url, body });
    if (url.startsWith("/token")) {
      res.writeHead(refreshStatus, { "content-type": "application/json" });
      if (refreshStatus !== 200) {
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      if (body.includes("grant_type=authorization_code")) {
        res.end(
          JSON.stringify({
            access_token: ACCESS,
            refresh_token: REFRESH,
            expires_in: 3600,
            scope: "openid offline_access email https://graph.microsoft.com/Mail.Read",
            id_token: [
              "eyJhbGciOiJub25lIn0",
              Buffer.from(JSON.stringify({ email: EMAIL })).toString("base64url"),
              "sig",
            ].join("."),
          }),
        );
        return;
      }
      res.end(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }));
      return;
    }
    if (url.startsWith("/v1.0/me/messages") || url.startsWith("/me/messages")) {
      res.writeHead(listStatus, { "content-type": "application/json" });
      if (listStatus !== 200) {
        res.end(JSON.stringify({ error: { code: "ErrorAccessDenied" } }));
        return;
      }
      const page = new URL(url, "http://graph.local").searchParams.get("$skiptoken");
      const next =
        page
          ? undefined
          : `http://graph.local/v1.0/me/messages?$skiptoken=page-2&$top=5`;
      res.end(JSON.stringify({ value: [graphMessage()], "@odata.nextLink": next }));
      return;
    }
    if (url.startsWith("/v1.0/me") || url === "/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mail: EMAIL, userPrincipalName: EMAIL }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => ms.listen(0, "127.0.0.1", resolve));
  const port = (ms.address() as { port: number }).port;
  tokenUrl = `http://127.0.0.1:${port}/token`;
  graphBaseUrl = `http://127.0.0.1:${port}/v1.0`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    ms.close((err) => (err ? reject(err) : resolve()));
  });
});

function microsoft() {
  return new MicrosoftAdapter({
    clientId: "test-microsoft-client-id",
    clientSecret: "test-microsoft-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/microsoft/callback",
    tenant: "common",
    tokenUrl,
    graphBaseUrl,
  });
}

function stubGmail() {
  return new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });
}

function buildApp(mode: "single" | "multi" = "multi") {
  const store = new MemoryStore();
  const vault = new MemoryTokenVault(MASTER);
  const app = createApp({
    store,
    vault,
    gmail: stubGmail(),
    microsoft: microsoft(),
    publicBaseUrl: "http://localhost:8787",
    apiSecret: API_SECRET,
    mode,
    gmailScopes: ["openid"],
    microsoftScopes: [
      "openid",
      "offline_access",
      "email",
      "https://graph.microsoft.com/Mail.Read",
    ],
    microsoftOauthRedirectUri: "http://localhost:8787/v1/oauth/microsoft/callback",
    queue: null,
  });
  return { app, store, vault };
}

function activeGrant(id = "grant_ms"): Grant {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "microsoft",
    email: EMAIL,
    status: "active",
    scopes: ["https://graph.microsoft.com/Mail.Read"],
    createdAt: now,
    updatedAt: now,
  };
}

describe("Microsoft OAuth connect", () => {
  it("connects via Microsoft callback and seals the refresh token", async () => {
    hits = [];
    refreshStatus = 200;
    const { app, vault } = buildApp();
    const auth = { authorization: `Bearer ${API_SECRET}`, "content-type": "application/json" };

    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        externalUserId: "user-ms",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { linkToken: string };
    const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(connect.status, 200);
    const html = await connect.text();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) =>
      (m[1] ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", '"'),
    );
    const msAuth = hrefs.map((h) => new URL(h)).find((u) => u.hostname.includes("microsoftonline"));
    assert.ok(msAuth);
    assert.equal(msAuth.pathname.includes("/common/"), true);
    assert.equal(
      msAuth.searchParams.get("redirect_uri"),
      "http://localhost:8787/v1/oauth/microsoft/callback",
    );
    assert.match(msAuth.searchParams.get("scope") ?? "", /Mail\.Read/);
    const state = msAuth.searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/v1/oauth/microsoft/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    const redirected = new URL(callback.headers.get("location") ?? "");
    const publicToken = redirected.searchParams.get("public_token");
    assert.ok(publicToken);

    const exchanged = await app.request("/v1/grants/exchange", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ publicToken }),
    });
    const { grantId } = (await exchanged.json()) as { grantId: string };
    const listed = await app.request("/v1/grants?externalUserId=user-ms", { headers: auth });
    const { grants } = (await listed.json()) as {
      grants: { id: string; email: string; provider: string }[];
    };
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.provider, "microsoft");
    assert.equal(grants[0]?.email, EMAIL);
    const opened = await vault.open((await vault.getCiphertext(grantId))!, {
      grantId,
      tenantId: "default",
    });
    assert.equal(opened, REFRESH);
  });

  it("returns a Microsoft token error instead of 500", async () => {
    hits = [];
    refreshStatus = 401;
    const { app } = buildApp("single");
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-1",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    const session = (await created.json()) as { linkToken: string };
    const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    const hrefs = [...(await connect.text()).matchAll(/href="([^"]+)"/g)].map((m) =>
      (m[1] ?? "").replaceAll("&amp;", "&"),
    );
    const msAuth = hrefs.map((h) => new URL(h)).find((u) => u.hostname.includes("microsoftonline"));
    assert.ok(msAuth);
    const state = msAuth.searchParams.get("state");
    assert.ok(state);
    const callback = await app.request(
      `/v1/oauth/microsoft/callback?code=bad&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 400);
    const html = await callback.text();
    assert.match(html, /Microsoft token exchange failed/);
    assert.match(html, /expired or was already used|Start Connect again/i);
  });
});

describe("Microsoft Graph message list", () => {
  it("lists a normalized message from the vaulted refresh token", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 200;
    const { app, store, vault } = buildApp("single");
    const grant = activeGrant();
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });

    const listed = await app.request(`/v1/grants/${grant.id}/messages?limit=5&cursor=page-2`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { messages: Message[]; nextCursor?: string };
    assert.equal(body.nextCursor, undefined);
    assert.equal(body.messages.length, 1);
    const message = body.messages[0];
    assert.ok(message);
    assert.equal(message.id, "msg_AAMkAGI2TG93AAA=");
    assert.equal(message.providerMessageId, "AAMkAGI2TG93AAA=");
    assert.equal(message.threadId, "AAQkAGI2Conversation=");
    assert.equal(message.subject, "Graph normalized hello");
    assert.equal(message.snippet, "Hello from Graph");
    assert.deepEqual(message.from, [{ name: "Lovelace, Ada", email: "ada@example.com" }]);
    assert.deepEqual(message.to, [{ email: EMAIL }]);
    assert.deepEqual(message.cc, [{ name: "Grace Hopper", email: "grace@example.com" }]);
    assert.equal(message.hasAttachments, true);
    assert.deepEqual(message.folderIds, ["AQMkAGI2AAAA="]);
    assert.deepEqual(message.labels, ["Blue category"]);
    assert.equal(message.body?.html, "<p>Hello from Graph</p>");
    assert.equal(JSON.stringify(body).includes(REFRESH), false);
    assert.equal(JSON.stringify(body).includes(ACCESS), false);

    const refresh = hits.find((hit) => hit.url.startsWith("/token"));
    assert.ok(refresh);
    assert.equal(new URLSearchParams(refresh.body).get("refresh_token"), REFRESH);
    const list = hits.find((hit) => hit.url.includes("/me/messages"));
    assert.ok(list);
    const listUrl = new URL(list.url, "http://graph.local");
    assert.equal(listUrl.searchParams.get("$top"), "5");
    assert.equal(listUrl.searchParams.get("$skiptoken"), "page-2");

    hits = [];
    const again = await app.request(`/v1/grants/${grant.id}/messages`);
    const firstPage = (await again.json()) as { nextCursor?: string };
    assert.equal(firstPage.nextCursor, "page-2");
  });

  it("marks needs_reauth when Graph rejects the access token", async () => {
    hits = [];
    refreshStatus = 200;
    listStatus = 401;
    const { app, store, vault } = buildApp("single");
    const grant = activeGrant("grant_ms_reauth");
    await store.putGrant(grant);
    await vault.seal(REFRESH, { grantId: grant.id, tenantId: grant.tenantId });
    const rejected = await app.request(`/v1/grants/${grant.id}/messages`);
    assert.equal(rejected.status, 409);
    assert.equal(((await rejected.json()) as { error: string }).error, "needs_reauth");
    assert.equal((await store.getGrant(grant.id))?.status, "needs_reauth");
  });
});
