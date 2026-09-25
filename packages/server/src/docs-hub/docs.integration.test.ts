import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "../routes/app.js";
import { MemoryStore } from "../store.js";
import { MemoryTokenVault } from "../vault/memory-vault.js";

describe("GET /docs", () => {
  function buildApp() {
    return createApp({
      store: new MemoryStore(),
      vault: new MemoryTokenVault("test-master-key-at-least-16"),
      gmail: new GmailAdapter({
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "http://localhost/v1/oauth/gmail/callback",
      }),
      publicBaseUrl: "http://localhost",
      apiSecret: "test-secret-key-at-least-16",
      mode: "single",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      storeKind: "memory",
      queue: null,
      rateLimiter: null,
    });
  }

  it("serves HTML docs hub without breaking health JSON", async () => {
    const app = buildApp();

    for (const path of ["/docs", "/docs/"]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const html = await res.text();
      assert.match(html, /data-testid="docs-hub"/);
      assert.match(html, /Host docs/);
      assert.match(html, /class="shell docs-shell"/);
      assert.match(html, /href="\/status"/);
      assert.match(html, /@inboxlink\/core@0\.1\.1/);
      assert.match(html, /@inboxlink\/sdk@0\.1\.0/);
      assert.match(html, /after #40 publish/);
      assert.doesNotMatch(html, /npm i @inboxlink\/sdk@0\.1\.1/);
      assert.match(html, /inboxlink\/wiki/);
    }

    for (const path of ["/", "/health", "/health/"]) {
      const health = await app.request(path);
      assert.equal(health.status, 200, path);
      const body = (await health.json()) as { ok: boolean; service: string };
      assert.equal(body.ok, true);
      assert.equal(body.service, "inboxlink");
    }

    const home = await app.request("/home");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /data-testid="landing-github"/);

    const status = await app.request("/status");
    assert.equal(status.status, 200);
    assert.match(status.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await status.text(), /Inbox<span>Link<\/span>/);
  });

  it("does not replace Connect HTML", async () => {
    const app = buildApp();
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "docs-hub-user",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { linkToken: string };
    const connect = await app.request(
      `/v1/connect/${encodeURIComponent(session.linkToken)}`,
    );
    assert.equal(connect.status, 200);
    const html = await connect.text();
    assert.match(html, /Connect your inbox/);
    assert.match(html, /data-testid="connect-cta"/);
    assert.doesNotMatch(html, /data-testid="docs-hub"/);
  });
});
