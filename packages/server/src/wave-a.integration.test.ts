import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import { SCHEMA_SQL } from "./db/schema.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
];

function buildApp(mode: "single" | "multi", store = new MemoryStore()) {
  const vault = new MemoryTokenVault("test-master-key-at-least-16");
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });
  const app = createApp({
    store,
    vault,
    gmail,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "tenant-api-key-test",
    mode,
    gmailScopes: SCOPES,
    queue: null,
    rateLimiter: null,
  });
  return { app, store };
}

describe("Wave A — schema.sql lockdown", () => {
  it("requires Bearer in multi and serves SQL when authorized", async () => {
    const { app } = buildApp("multi");
    const denied = await app.request("/v1/schema.sql");
    assert.equal(denied.status, 401);

    const allowed = await app.request("/v1/schema.sql", {
      headers: { authorization: "Bearer tenant-api-key-test" },
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.text();
    assert.match(body, /CREATE TABLE IF NOT EXISTS token_vault/);
    assert.equal(body, SCHEMA_SQL);
  });

  it("remains available without Bearer in single (local demos)", async () => {
    const { app } = buildApp("single");
    const res = await app.request("/v1/schema.sql");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /link_sessions/);
  });
});

describe("Wave A — HTML security headers", () => {
  it("sets CSP and frame/nosniff/referrer on Connect HTML", async () => {
    const { app, store } = buildApp("multi");
    const session = await store.createSession({
      tenantId: "default",
      externalUserId: "u1",
      redirectUri: "http://localhost:9999/done",
      products: ["messages"],
    });
    const res = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(await res.text(), /Content-Security-Policy/);
  });
});

describe("Wave A — oauth_state consume + link_sessions GC", () => {
  it("consumes oauth state once (memory)", async () => {
    const store = new MemoryStore();
    const session = await store.createSession({
      tenantId: "default",
      externalUserId: "u1",
      redirectUri: "http://localhost:9999/done",
      products: ["messages"],
    });
    session.oauthState = "state-once";
    session.codeVerifier = "verifier-once";
    await store.saveSession(session);

    const first = await store.consumeOAuthState("state-once");
    assert.ok(first);
    assert.equal(first.codeVerifier, "verifier-once");
    assert.equal(first.oauthState, undefined);
    assert.equal(await store.consumeOAuthState("state-once"), undefined);
    assert.equal(await store.findSessionByOAuthState("state-once"), undefined);
  });

  it("deletes sessions past expires_at", async () => {
    const store = new MemoryStore();
    const live = await store.createSession({
      tenantId: "default",
      externalUserId: "live",
      redirectUri: "http://localhost:9999/done",
      products: ["messages"],
      ttlMs: 60_000,
    });
    const expired = await store.createSession({
      tenantId: "default",
      externalUserId: "gone",
      redirectUri: "http://localhost:9999/done",
      products: ["messages"],
      ttlMs: 1,
    });
    expired.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveSession(expired);

    const removed = await store.deleteExpiredSessions();
    assert.equal(removed, 1);
    assert.ok(await store.getSession(live.id));
    assert.equal(await store.getSession(expired.id), undefined);
  });
});
