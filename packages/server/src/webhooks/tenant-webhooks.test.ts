import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "../routes/app.js";
import { MemoryStore } from "../store.js";
import { MemoryTokenVault } from "../vault/memory-vault.js";
import {
  WEBHOOK_SIGNATURE_V1_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  createTenantWebhookBus,
  signWebhookV1,
} from "./deliver.js";
import {
  MAX_WEBHOOK_ENDPOINTS_PER_TENANT,
  MemoryWebhookEndpointStore,
  WebhookRegistry,
  validateWebhookUrl,
} from "./endpoints.js";

const MASTER = "test-master-key-at-least-16";
const gmail = new GmailAdapter({
  clientId: "c",
  clientSecret: "s",
  redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
});

function buildApp(registry: WebhookRegistry | null) {
  return createApp({
    store: new MemoryStore(),
    vault: new MemoryTokenVault(MASTER),
    gmail,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "a-secret",
    tenantId: "tenant-a",
    tenantSecrets: { "tenant-a": "a-secret", "tenant-b": "b-secret" },
    mode: "multi",
    gmailScopes: ["openid"],
    queue: null,
    rateLimiter: null,
    webhookRegistry: registry,
  });
}

const A = { authorization: "Bearer a-secret", "content-type": "application/json" };
const B = { authorization: "Bearer b-secret", "content-type": "application/json" };

describe("validateWebhookUrl", () => {
  it("accepts public https and rejects everything unsafe when hosted", () => {
    assert.ok(validateWebhookUrl("https://hooks.example.com/inboxlink"));
    for (const bad of [
      "http://hooks.example.com/x",
      "https://localhost/x",
      "https://foo.localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.5/x",
      "https://172.20.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://svc.internal/x",
      "https://user:pw@hooks.example.com/x",
      "ftp://hooks.example.com/x",
      "not a url",
      "",
    ]) {
      assert.equal(validateWebhookUrl(bad), null, bad);
    }
    assert.equal(validateWebhookUrl(42), null);
  });

  it("allows http/localhost only when insecure URLs are enabled (local dev)", () => {
    assert.ok(validateWebhookUrl("http://localhost:3000/hook", { allowInsecure: true }));
    assert.equal(validateWebhookUrl("ftp://x/y", { allowInsecure: true }), null);
  });
});

describe("/v1/webhooks", () => {
  it("creates, lists (no secret), and deletes within a tenant; hides other tenants", async () => {
    const app = buildApp(new WebhookRegistry(new MemoryWebhookEndpointStore(), MASTER));
    const created = await app.request("/v1/webhooks", {
      method: "POST",
      headers: A,
      body: JSON.stringify({ url: "https://hooks.example.com/a", events: ["message.created"] }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; secret: string; events: string[] };
    assert.match(body.secret, /^whsec_/);
    assert.deepEqual(body.events, ["message.created"]);

    const listA = (await (await app.request("/v1/webhooks", { headers: A })).json()) as {
      webhooks: Array<Record<string, unknown>>;
    };
    assert.equal(listA.webhooks.length, 1);
    assert.equal("secret" in listA.webhooks[0]!, false);
    assert.equal("secretCiphertext" in listA.webhooks[0]!, false);

    const listB = (await (await app.request("/v1/webhooks", { headers: B })).json()) as {
      webhooks: unknown[];
    };
    assert.equal(listB.webhooks.length, 0);

    const crossDelete = await app.request(`/v1/webhooks/${body.id}`, { method: "DELETE", headers: B });
    assert.equal(crossDelete.status, 404);
    const del = await app.request(`/v1/webhooks/${body.id}`, { method: "DELETE", headers: A });
    assert.equal(del.status, 204);
  });

  it("validates input, enforces the per-tenant cap, and requires auth", async () => {
    const app = buildApp(new WebhookRegistry(new MemoryWebhookEndpointStore(), MASTER));
    const post = (b: unknown, h = A) =>
      app.request("/v1/webhooks", { method: "POST", headers: h, body: JSON.stringify(b) });
    assert.equal((await post({ url: "http://hooks.example.com/x" })).status, 400);
    assert.equal((await post({ url: "https://169.254.169.254/x" })).status, 400);
    assert.equal((await post({ url: "https://hooks.example.com/x", events: ["nope"] })).status, 400);
    assert.equal((await app.request("/v1/webhooks", { method: "POST", headers: A, body: "{" })).status, 400);
    assert.equal((await post({ url: "https://hooks.example.com/x" }, { "content-type": "application/json" } as never)).status, 401);

    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_TENANT; i++) {
      assert.equal((await post({ url: `https://hooks.example.com/${i}` })).status, 201);
    }
    assert.equal((await post({ url: "https://hooks.example.com/over" })).status, 409);
    // Another tenant is unaffected by A's cap.
    assert.equal((await post({ url: "https://hooks.example.com/b" }, B)).status, 201);
  });

  it("returns 501 when no registry is configured", async () => {
    const res = await buildApp(null).request("/v1/webhooks", { headers: A });
    assert.equal(res.status, 501);
  });
});

describe("tenant-scoped delivery", () => {
  async function setup() {
    const registry = new WebhookRegistry(new MemoryWebhookEndpointStore(), MASTER);
    const a = await registry.create({ tenantId: "tenant-a", url: "https://a.example.com/h" });
    const b = await registry.create({
      tenantId: "tenant-b",
      url: "https://b.example.com/h",
      events: ["grant.connected"],
    });
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return { registry, a, b, calls, fetchImpl };
  }

  it("sends a tenant's event only to that tenant's endpoints, with a verifiable timestamped signature", async () => {
    const { registry, a, calls, fetchImpl } = await setup();
    const bus = createTenantWebhookBus({ registry, fetchImpl });
    const result = await bus.emit("message.created", { tenantId: "tenant-a", grantId: "g1" });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://a.example.com/h");
    const ts = calls[0]!.headers[WEBHOOK_TIMESTAMP_HEADER]!;
    assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 10);
    assert.equal(
      calls[0]!.headers[WEBHOOK_SIGNATURE_V1_HEADER],
      signWebhookV1(a.secret, ts, calls[0]!.body),
    );
  });

  it("honours per-endpoint event filters and never crosses tenants", async () => {
    const { registry, calls, fetchImpl } = await setup();
    const bus = createTenantWebhookBus({ registry, fetchImpl });
    await bus.emit("message.created", { tenantId: "tenant-b" }); // B only wants grant.connected
    assert.equal(calls.length, 0);
    await bus.emit("grant.connected", { tenantId: "tenant-b" });
    assert.deepEqual(calls.map((c) => c.url), ["https://b.example.com/h"]);
    await bus.emit("grant.connected", { tenantId: "unknown-tenant" });
    assert.equal(calls.length, 1);
    await bus.emit("grant.connected", {}); // no tenantId: dropped, not broadcast
    assert.equal(calls.length, 1);
  });

  it("applies the legacy env endpoint to the default tenant only", async () => {
    const { registry, calls, fetchImpl } = await setup();
    const bus = createTenantWebhookBus({
      registry,
      fetchImpl,
      fallback: { url: "https://legacy.example.com/h", secret: "legacy" },
      fallbackTenantId: "tenant-a",
    });
    await bus.emit("sync.completed", { tenantId: "tenant-b" });
    assert.equal(calls.length, 0);
    await bus.emit("sync.completed", { tenantId: "tenant-a" });
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "https://a.example.com/h",
      "https://legacy.example.com/h",
    ]);
  });

  it("times out a hanging host instead of waiting indefinitely", async () => {
    const { registry } = await setup();
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const bus = createTenantWebhookBus({
      registry,
      fetchImpl: hang,
      timeoutMs: 20,
      sleep: async () => {},
    });
    const started = Date.now();
    const result = await bus.emit("message.created", { tenantId: "tenant-a" });
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 2000);
  });

  it("skips an endpoint whose secret can no longer be opened", async () => {
    const store = new MemoryWebhookEndpointStore();
    const original = new WebhookRegistry(store, MASTER);
    await original.create({ tenantId: "tenant-a", url: "https://a.example.com/h" });
    const rotated = new WebhookRegistry(store, "a-different-master-key-xyz");
    assert.deepEqual(await rotated.targetsFor("tenant-a", "message.created"), []);
  });
});
