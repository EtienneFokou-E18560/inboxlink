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

describe("GET /home and /docs", () => {
  it("redirect to the website without changing health JSON", async () => {
    const app = buildApp();

    for (const [path, target] of [
      ["/home", "https://getinboxlink.vercel.app/"],
      ["/home/", "https://getinboxlink.vercel.app/"],
      ["/docs", "https://getinboxlink.vercel.app/quick-start/"],
      ["/docs/", "https://getinboxlink.vercel.app/quick-start/"],
    ] as const) {
      const res = await app.request(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), target, path);
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

describe("legal pages", () => {
  it("serves public /privacy and /terms HTML without auth", async () => {
    const app = buildApp();
    for (const [path, heading] of [
      ["/privacy", "Privacy"],
      ["/terms", "Terms"],
    ] as const) {
      const res = await app.request(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const html = await res.text();
      assert.match(html, new RegExp(`<h1>${heading}</h1>`));
      assert.match(html, /<a href="https:\/\/getinboxlink\.vercel\.app">Home<\/a>/);
    }
  });
});
