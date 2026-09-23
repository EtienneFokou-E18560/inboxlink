import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const API_SECRET = "tenant-api-key-test";
const REFRESH = "1//gmail-refresh-token-test";
const EMAIL = "tester@gmail.com";

let google: Server;
let tokenUrl = "";
let userinfoUrl = "";

before(async () => {
  google = createServer((req, res) => {
    if (req.url?.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "ya29.test-access",
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/userinfo")) {
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer ya29.test-access") {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: EMAIL }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
  const port = (google.address() as { port: number }).port;
  tokenUrl = `http://127.0.0.1:${port}/token`;
  userinfoUrl = `http://127.0.0.1:${port}/userinfo`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    google.close((err) => (err ? reject(err) : resolve()));
  });
});

function buildApp() {
  const store = new MemoryStore();
  const vault = new MemoryTokenVault("test-master-key-at-least-16");
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
    tokenUrl,
    userinfoUrl,
  });
  const app = createApp({
    store,
    vault,
    gmail,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: API_SECRET,
    mode: "multi",
    gmailScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
      "email",
    ],
    queue: null,
    rateLimiter: null,
  });
  return { app, vault, store };
}

describe("grants, vault, and Gmail OAuth", () => {
  it("requires the tenant API key on host routes", async () => {
    const { app } = buildApp();
    const denied = await app.request("/v1/grants?externalUserId=user-1");
    assert.equal(denied.status, 401);
    const wrongKey = await app.request("/v1/grants?externalUserId=user-1", {
      headers: { authorization: "Bearer not-the-tenant-key" },
    });
    assert.equal(wrongKey.status, 401);
    for (const path of ["/", "/health", "/health/"]) {
      const health = await app.request(path);
      assert.equal(health.status, 200, path);
      const body = (await health.json()) as {
        ok: boolean;
        service: string;
        store: string;
        warning?: string;
        guidance?: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.service, "inboxlink");
      assert.equal(body.store, "memory");
      assert.equal(body.warning, "ephemeral_store");
      assert.match(body.guidance ?? "", /DATABASE_URL/);
    }
  });

  it("connects, lists the grant, and revoke clears ciphertext", async () => {
    const { app, vault } = buildApp();
    const auth = { authorization: `Bearer ${API_SECRET}`, "content-type": "application/json" };

    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        externalUserId: "user-1",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { linkToken: string; connectUrl: string };
    assert.match(session.connectUrl, /\/v1\/connect\//);

    const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(connect.status, 200);
    const html = await connect.text();
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /data-testid="connect-cta"/);
    assert.match(html, /This link expires/);
    assert.doesNotMatch(html, /Stub Connect UI/);
    const href = (html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"');
    const authUrl = new URL(href);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    assert.equal(
      authUrl.searchParams.get("redirect_uri"),
      "http://localhost:8787/v1/oauth/gmail/callback",
    );
    const state = authUrl.searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
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
    assert.equal(exchanged.status, 200);
    const { grantId } = (await exchanged.json()) as { grantId: string };
    assert.match(grantId, /^grant_/);

    const listed = await app.request("/v1/grants?externalUserId=user-1", { headers: auth });
    assert.equal(listed.status, 200);
    const { grants } = (await listed.json()) as {
      grants: { id: string; email: string; status: string }[];
    };
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.id, grantId);
    assert.equal(grants[0]?.email, EMAIL);
    assert.equal(grants[0]?.status, "active");
    assert.equal("tenantId" in (grants[0] ?? {}), false);
    assert.equal("externalUserId" in (grants[0] ?? {}), false);

    const ciphertext = await vault.getCiphertext(grantId);
    assert.ok(ciphertext);
    assert.equal(Buffer.from(ciphertext).toString("utf8").includes(REFRESH), false);
    const opened = await vault.open(ciphertext, { grantId, tenantId: "default" });
    assert.equal(opened, REFRESH);

    const reused = await app.request("/v1/grants/exchange", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ publicToken }),
    });
    assert.equal(reused.status, 400);

    const revoked = await app.request(`/v1/grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(revoked.status, 204);
    assert.equal(await vault.getCiphertext(grantId), undefined);

    const after = await app.request("/v1/grants?externalUserId=user-1", { headers: auth });
    const remaining = (await after.json()) as { grants: unknown[] };
    assert.deepEqual(remaining.grants, []);
  });
});

describe("OAuth callback when Google rejects the code", () => {
  it("returns the Google error instead of an unhandled 500", async () => {
    const google = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
    });
    await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
    const port = (google.address() as { port: number }).port;
    try {
      const store = new MemoryStore();
      const vault = new MemoryTokenVault("test-master-key-at-least-16");
      const gmail = new GmailAdapter({
        clientId: "test-client-id.apps.googleusercontent.com",
        clientSecret: "test-client-secret",
        redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
        tokenUrl: `http://127.0.0.1:${port}/token`,
        userinfoUrl: `http://127.0.0.1:${port}/userinfo`,
      });
      const app = createApp({
        store,
        vault,
        gmail,
        publicBaseUrl: "http://localhost:8787",
        apiSecret: API_SECRET,
        mode: "single",
        gmailScopes: ["openid"],
        oauthRedirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
        queue: null,
      });
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
      const href = ((await connect.text()).match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "")
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"');
      const state = new URL(href).searchParams.get("state");
      assert.ok(state);
      const callback = await app.request(
        `/v1/oauth/gmail/callback?code=used-code&state=${encodeURIComponent(state)}`,
      );
      assert.equal(callback.status, 400);
      const html = await callback.text();
      assert.match(html, /Google did not accept the authorization/);
      assert.match(html, /rejected the OAuth client/);
      assert.match(html, /Inbox<span>Link<\/span>/);
      const listed = await app.request("/v1/grants?externalUserId=user-1");
      const { grants } = (await listed.json()) as { grants: unknown[] };
      assert.equal(grants.length, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        google.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("Connect UI session errors", () => {
  function buildApp() {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault("test-master-key-at-least-16");
    const gmail = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
      tokenUrl,
      userinfoUrl,
    });
    return {
      store,
      app: createApp({
        store,
        vault,
        gmail,
        publicBaseUrl: "http://localhost:8787",
        apiSecret: API_SECRET,
        mode: "single",
        gmailScopes: ["openid"],
        oauthRedirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
        queue: null,
      }),
    };
  }

  it("shows a polished invalid-link page for unknown tokens", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/connect/not-a-real-token");
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /This connect link is invalid/);
    assert.match(html, /role="alert"/);
    assert.match(html, /Inbox<span>Link<\/span>/);
  });

  it("shows session-expiry UX when the link has timed out", async () => {
    const { app, store } = buildApp();
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-exp",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    const session = (await created.json()) as { linkToken: string; sessionId: string };
    const stored = await store.getSession(session.sessionId);
    assert.ok(stored);
    stored.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveSession(stored);

    const res = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /This connect link has expired/);
    assert.match(html, /request a new connect link/i);
    assert.doesNotMatch(html, /Continue with Google/);
  });

  it("explains completed sessions instead of offering another CTA", async () => {
    const { app, store } = buildApp();
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-done",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    const session = (await created.json()) as { linkToken: string; sessionId: string };
    const stored = await store.getSession(session.sessionId);
    assert.ok(stored);
    stored.status = "completed";
    await store.saveSession(stored);

    const res = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /This session already finished/);
    assert.doesNotMatch(html, /Continue with Google/);
  });
});
