import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "../routes/app.js";
import { MemoryStore, type GrantStore } from "../store.js";
import { MemoryTokenVault } from "../vault/memory-vault.js";
import { probeHealth } from "./health.js";
import { renderStatusPage } from "./status-page.js";

function buildApp(store: GrantStore = new MemoryStore(), storeKind: "memory" | "postgres" = "memory") {
  const vault = new MemoryTokenVault("test-master-key-at-least-16");
  const gmail = new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });
  return createApp({
    store,
    vault,
    gmail,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "tenant-api-key-test",
    mode: "single",
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    storeKind,
    queue: null,
    rateLimiter: null,
  });
}

describe("probeHealth", () => {
  it("returns ok memory snapshot with guidance", async () => {
    const result = await probeHealth({
      store: new MemoryStore(),
      mode: "single",
      storeKind: "memory",
      queue: null,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.service, "inboxlink");
    assert.equal(result.body.store, "memory");
    assert.equal(result.body.mode, "single");
    assert.equal(result.body.queue, "disabled");
    assert.equal(result.body.warning, "ephemeral_store");
    assert.match(result.body.guidance ?? "", /DATABASE_URL/);
  });

  it("returns postgres snapshot without warning", async () => {
    const result = await probeHealth({
      store: new MemoryStore(),
      mode: "multi",
      storeKind: "postgres",
      queue: { enqueue: async () => ({ jobId: "sjob_test" }), close: async () => {} },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.store, "postgres");
    assert.equal(result.body.mode, "multi");
    assert.equal(result.body.queue, "jobs");
    assert.equal(result.body.warning, undefined);
    assert.equal(result.body.guidance, undefined);
  });

  it("returns 503 when store.ready throws", async () => {
    const store = new MemoryStore();
    store.ready = async () => {
      throw new Error("db down");
    };
    const result = await probeHealth({
      store,
      mode: "single",
      storeKind: "postgres",
      queue: null,
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, "database_unavailable");
    assert.equal(result.body.queue, undefined);
    assert.match(result.body.guidance ?? "", /Postgres/);
  });
});

describe("renderStatusPage", () => {
  it("renders healthy fields with Connect brand and no secrets", () => {
    const html = renderStatusPage({
      health: {
        ok: true,
        service: "inboxlink",
        mode: "single",
        store: "postgres",
        queue: "disabled",
      },
    });
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /shell-status/);
    assert.match(html, /role="status"/);
    assert.match(html, /Operator status/);
    assert.match(html, /Healthy/);
    assert.match(html, /postgres/);
    assert.match(html, /single/);
    assert.match(html, /disabled/);
    assert.match(html, /data-testid="status-health-json"/);
    assert.match(html, /href="\/health"/);
    assert.match(html, /--accent:\s*#0f6e56/);
    assert.doesNotMatch(html, /api[_-]?secret/i);
    assert.doesNotMatch(html, /Bearer /);
    assert.doesNotMatch(html, /refresh[_-]?token/i);
    assert.doesNotMatch(html, /DATABASE_URL\s*=/);
  });

  it("escapes hostile values in health fields", () => {
    const html = renderStatusPage({
      health: {
        ok: false,
        service: "inboxlink",
        mode: "single",
        store: "memory",
        error: '<script>alert(1)</script>',
        guidance: 'See <img src=x onerror=alert(1)>',
      },
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x/);
  });

  it("marks ephemeral store as degraded", () => {
    const html = renderStatusPage({
      health: {
        ok: true,
        service: "inboxlink",
        mode: "single",
        store: "memory",
        queue: "disabled",
        warning: "ephemeral_store",
        guidance: "Set DATABASE_URL so Production uses Postgres.",
      },
    });
    assert.match(html, /Degraded/);
    assert.match(html, /ephemeral_store/);
    assert.match(html, /DATABASE_URL/);
  });
});

describe("GET /status HTML over health", () => {
  it("serves HTML while leaving / and /health as JSON", async () => {
    const app = buildApp();

    for (const path of ["/", "/health", "/health/"]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      const ct = res.headers.get("content-type") ?? "";
      assert.match(ct, /application\/json/);
      const body = (await res.json()) as { ok: boolean; store: string; queue: string };
      assert.equal(body.ok, true);
      assert.equal(body.store, "memory");
      assert.equal(body.queue, "disabled");
    }

    for (const path of ["/status", "/status/"]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      const ct = res.headers.get("content-type") ?? "";
      assert.match(ct, /text\/html/);
      const html = await res.text();
      assert.match(html, /Inbox<span>Link<\/span>/);
      assert.match(html, /memory/);
      assert.match(html, /disabled/);
      assert.match(html, /ephemeral_store/);
      assert.match(html, /href="\/health"/);
    }
  });

  it("mirrors 503 health into status HTML when the store is down", async () => {
    const store = new MemoryStore();
    store.ready = async () => {
      throw new Error("db down");
    };
    const app = buildApp(store, "postgres");

    const json = await app.request("/health");
    assert.equal(json.status, 503);
    const body = (await json.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "database_unavailable");

    const htmlRes = await app.request("/status");
    assert.equal(htmlRes.status, 503);
    const html = await htmlRes.text();
    assert.match(html, /Unavailable/);
    assert.match(html, /database_unavailable/);
    assert.doesNotMatch(html, /api[_-]?secret/i);
  });
});
