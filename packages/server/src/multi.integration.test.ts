import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { Grant } from "@inboxlink/core";
import {
  buildTenantSecrets,
  DEV_API_SECRET_PLACEHOLDER,
  parseBearerToken,
  parseTenantSecrets,
  resolveTenantId,
} from "./auth.js";
import { assertMultiModeSecrets, loadConfig } from "./config.js";
import { createRateLimiter } from "./rate-limit.js";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

describe("strict Bearer parsing", () => {
  it("accepts only a single Bearer credential", () => {
    assert.equal(parseBearerToken("Bearer secret-token"), "secret-token");
    assert.equal(parseBearerToken("bearer secret-token"), "secret-token");
    assert.equal(parseBearerToken("Bearer  secret-token"), "secret-token");
    assert.equal(parseBearerToken(undefined), null);
    assert.equal(parseBearerToken(""), null);
    assert.equal(parseBearerToken("Bearer"), null);
    assert.equal(parseBearerToken("Bearer "), null);
    assert.equal(parseBearerToken("Basic secret-token"), null);
    assert.equal(parseBearerToken("Bearer token with spaces"), null);
    assert.equal(parseBearerToken("Token secret-token"), null);
  });

  it("resolves tenants from a secret map", () => {
    const secrets = { default: "sec-default", acme: "sec-acme" };
    assert.equal(resolveTenantId("sec-acme", secrets), "acme");
    assert.equal(resolveTenantId("sec-default", secrets), "default");
    assert.equal(resolveTenantId("nope", secrets), undefined);
  });

  it("parses INBOXLINK_TENANT_SECRETS pairs", () => {
    assert.deepEqual(parseTenantSecrets("acme=one,beta=two=still"), {
      acme: "one",
      beta: "two=still",
    });
    assert.deepEqual(buildTenantSecrets({ apiSecret: "root", tenantId: "default", extra: { acme: "a" } }), {
      default: "root",
      acme: "a",
    });
  });
});

describe("multi mode config defaults", () => {
  it("keeps single as the default mode", () => {
    const config = loadConfig({});
    assert.equal(config.mode, "single");
  });

  it("rejects the placeholder secret when multi runs hosted", () => {
    assert.throws(
      () =>
        assertMultiModeSecrets(
          "multi",
          { default: DEV_API_SECRET_PLACEHOLDER },
          { VERCEL: "1" },
        ),
      /non-default Bearer secret/,
    );
    assert.doesNotThrow(() =>
      assertMultiModeSecrets("multi", { default: "real-secret" }, { VERCEL: "1" }),
    );
    assert.doesNotThrow(() =>
      assertMultiModeSecrets(
        "multi",
        { default: DEV_API_SECRET_PLACEHOLDER },
        { NODE_ENV: "development" },
      ),
    );
  });
});

describe("rate limiter", () => {
  it("returns 429 after the window budget is spent", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ windowMs: 1_000, maxRequests: 2, now: () => now });
    assert.equal(limiter.check("t").ok, true);
    assert.equal(limiter.check("t").ok, true);
    const limited = limiter.check("t");
    assert.equal(limited.ok, false);
    if (!limited.ok) assert.ok(limited.retryAfterSec >= 1);
    now = 2_500;
    assert.equal(limiter.check("t").ok, true);
  });
});

describe("multi-tenant isolation", () => {
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });

  it("rejects Basic and empty Bearer credentials", async () => {
    const app = createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "tenant-a-secret",
      mode: "multi",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: null,
    });
    for (const authorization of ["Basic tenant-a-secret", "Bearer", "Bearer ", "Token tenant-a-secret"]) {
      const res = await app.request("/v1/grants?externalUserId=u1", {
        headers: { authorization },
      });
      assert.equal(res.status, 401, authorization);
    }
  });

  it("isolates sessions, grants, and public tokens across tenants", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault("test-master-key-at-least-16");
    const app = createApp({
      store,
      vault,
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "tenant-a-secret",
      tenantId: "tenant-a",
      tenantSecrets: {
        "tenant-a": "tenant-a-secret",
        "tenant-b": "tenant-b-secret",
      },
      mode: "multi",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: null,
    });

    const authA = {
      authorization: "Bearer tenant-a-secret",
      "content-type": "application/json",
    };
    const authB = {
      authorization: "Bearer tenant-b-secret",
      "content-type": "application/json",
    };

    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: authA,
      body: JSON.stringify({
        externalUserId: "user-1",
        redirectUri: "https://host.example/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { sessionId: string; linkToken: string };

    const foreignSession = await app.request(`/v1/link/sessions/${session.sessionId}`, {
      headers: authB,
    });
    assert.equal(foreignSession.status, 404);

    const ownSession = await app.request(`/v1/link/sessions/${session.sessionId}`, {
      headers: authA,
    });
    assert.equal(ownSession.status, 200);

    const now = new Date().toISOString();
    const grantA: Grant = {
      id: "grant_a",
      tenantId: "tenant-a",
      externalUserId: "user-1",
      provider: "gmail",
      email: "a@example.com",
      status: "active",
      scopes: ["openid"],
      createdAt: now,
      updatedAt: now,
    };
    const grantB: Grant = {
      ...grantA,
      id: "grant_b",
      tenantId: "tenant-b",
      externalUserId: "user-1",
      email: "b@example.com",
    };
    await store.putGrant(grantA);
    await store.putGrant(grantB);

    const listA = await app.request("/v1/grants?externalUserId=user-1", { headers: authA });
    const bodyA = (await listA.json()) as { grants: { id: string; email: string }[] };
    assert.deepEqual(
      bodyA.grants.map((g) => g.id),
      ["grant_a"],
    );
    assert.equal(bodyA.grants[0] && "tenantId" in bodyA.grants[0], false);

    const listB = await app.request("/v1/grants?externalUserId=user-1", { headers: authB });
    const bodyB = (await listB.json()) as { grants: { id: string }[] };
    assert.deepEqual(
      bodyB.grants.map((g) => g.id),
      ["grant_b"],
    );

    const denyDelete = await app.request("/v1/grants/grant_a", {
      method: "DELETE",
      headers: authB,
    });
    assert.equal(denyDelete.status, 404);
    assert.ok(await store.getGrant("grant_a"));

    const stored = await store.getSession(session.sessionId);
    assert.ok(stored);
    stored.status = "completed";
    stored.grantId = "grant_a";
    stored.publicToken = "public-token-a";
    await store.saveSession(stored);

    const crossExchange = await app.request("/v1/grants/exchange", {
      method: "POST",
      headers: authB,
      body: JSON.stringify({ publicToken: "public-token-a" }),
    });
    assert.equal(crossExchange.status, 400);
    assert.equal(await store.consumePublicToken("public-token-a", "tenant-a"), "grant_a");
  });

  it("rate-limits multi host routes", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const app = createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "tenant-a-secret",
      mode: "multi",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: limiter,
    });
    const headers = { authorization: "Bearer tenant-a-secret" };
    assert.equal((await app.request("/v1/grants?externalUserId=u1", { headers })).status, 200);
    assert.equal((await app.request("/v1/grants?externalUserId=u1", { headers })).status, 200);
    const limited = await app.request("/v1/grants?externalUserId=u1", { headers });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json() as { error: string }).error, "rate_limited");
    assert.ok(limited.headers.get("retry-after"));
  });

  it("rate-limits single-mode host and Connect routes", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const app = createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused-in-single",
      mode: "single",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: limiter,
    });
    const ip = { "x-forwarded-for": "203.0.113.10" };
    assert.equal(
      (await app.request("/v1/grants?externalUserId=u1", { headers: ip })).status,
      200,
    );
    assert.equal(
      (await app.request("/v1/grants?externalUserId=u1", { headers: ip })).status,
      200,
    );
    const limitedHost = await app.request("/v1/grants?externalUserId=u1", { headers: ip });
    assert.equal(limitedHost.status, 429);
    assert.equal((await limitedHost.json() as { error: string }).error, "rate_limited");
    assert.ok(limitedHost.headers.get("retry-after"));

    const connectLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const connectApp = createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: "unused-in-single",
      mode: "single",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: connectLimiter,
    });
    const connectIp = { "x-forwarded-for": "198.51.100.20" };
    assert.equal(
      (await connectApp.request("/v1/connect/missing-token", { headers: connectIp })).status,
      404,
    );
    const limitedConnect = await connectApp.request("/v1/connect/missing-token", {
      headers: connectIp,
    });
    assert.equal(limitedConnect.status, 429);
    assert.equal((await limitedConnect.json() as { error: string }).error, "rate_limited");
  });
});

describe("CORS allowlist", () => {
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });

  it("reflects allowlisted origins and omits unknown ones (never *)", async () => {
    const app = createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail,
      publicBaseUrl: "https://inboxlink.example",
      apiSecret: "unused-in-single",
      mode: "single",
      gmailScopes: ["openid"],
      queue: null,
      rateLimiter: null,
      allowedRedirectOrigins: ["https://app.example.com"],
    });

    const allowed = await app.request("/health", {
      headers: { origin: "https://app.example.com" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");

    const sameOrigin = await app.request("/health", {
      headers: { origin: "https://inboxlink.example" },
    });
    assert.equal(
      sameOrigin.headers.get("access-control-allow-origin"),
      "https://inboxlink.example",
    );

    const denied = await app.request("/health", {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const noOrigin = await app.request("/health");
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  });
});
