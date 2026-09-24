import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

function buildApp() {
  const store = new MemoryStore();
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
    mode: "multi",
    gmailScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
      "email",
    ],
    queue: null,
    rateLimiter: null,
  });
}

describe("GET /home landing", () => {
  it("serves Vault door HTML without changing health JSON", async () => {
    const app = buildApp();

    for (const path of ["/home", "/home/"]) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      const type = res.headers.get("content-type") ?? "";
      assert.match(type, /text\/html/);
      const html = await res.text();
      assert.match(html, /Inbox<span>Link<\/span>/);
      assert.match(html, /Connect mailboxes without holding tokens/);
      assert.match(html, /data-testid="landing-github"/);
      assert.match(html, /data-testid="landing-docs"/);
      assert.match(html, /data-testid="landing-wiki"/);
      assert.match(html, /data-testid="landing-npm"/);
      assert.match(html, /href="\/docs"/);
      assert.match(html, /@inboxlink\/sdk@0\.1\.1/);
      assert.match(html, /href="\/health"/);
    }

    for (const path of ["/", "/health"]) {
      const health = await app.request(path);
      assert.equal(health.status, 200, path);
      const body = (await health.json()) as { ok: boolean; service: string };
      assert.equal(body.ok, true);
      assert.equal(body.service, "inboxlink");
    }
  });
});
