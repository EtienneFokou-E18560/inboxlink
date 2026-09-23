import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { ImapAdapter, type ImapSession } from "@inboxlink/adapters-imap";
import type { Grant, Message } from "@inboxlink/core";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const MASTER = "test-master-key-at-least-16";
const PASSWORD = "imap-app-password-not-for-logs";

function gmail() {
  return new GmailAdapter({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
  });
}

function mockImap(): ImapAdapter {
  return new ImapAdapter({
    transportFactory: async (credentials) => {
      assert.equal(credentials.password, PASSWORD);
      const session: ImapSession = {
        async searchAllUids() {
          return [1, 2, 3];
        },
        async fetchByUids(uids) {
          return uids.map((uid) => ({
            uid,
            envelope: {
              subject: `IMAP ${uid}`,
              from: [{ name: "Ada", address: "ada@example.com" }],
              to: [{ address: credentials.user }],
              date: new Date("2026-03-10T12:00:00.000Z"),
            },
            source: Buffer.from(`Content-Type: text/plain\r\n\r\nbody-${uid}`),
            flags: new Set(["\\Seen"]),
          }));
        },
        async close() {},
      };
      return session;
    },
  });
}

function appFor(store: MemoryStore, vault: MemoryTokenVault, imap = mockImap()) {
  return createApp({
    store,
    vault,
    gmail: gmail(),
    imap,
    publicBaseUrl: "http://localhost:8787",
    apiSecret: "tenant-api-key-test",
    mode: "single",
    gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    queue: null,
  });
}

describe("IMAP connect + list (no live IMAP)", () => {
  it("seals credentials on connect and lists INBOX without leaking the password", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const app = appFor(store, vault);

    const sessionRes = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-imap",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = (await sessionRes.json()) as { linkToken: string; connectUrl: string };
    const connect = await app.request(`/v1/connect/${sessionBody.linkToken}`);
    assert.equal(connect.status, 200);
    const html = await connect.text();
    assert.equal(html.includes("Connect IMAP"), true);
    assert.equal(html.includes("/imap"), true);

    const form = new URLSearchParams({
      host: "imap.example.com",
      port: "993",
      secure: "true",
      user: "me@example.com",
      password: PASSWORD,
    });
    const connected = await app.request(`/v1/connect/${sessionBody.linkToken}/imap`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    assert.equal(connected.status, 302);
    const location = connected.headers.get("location") ?? "";
    assert.equal(location.includes("public_token="), true);
    assert.equal(location.includes(PASSWORD), false);

    const publicToken = new URL(location).searchParams.get("public_token");
    assert.ok(publicToken);
    const exchanged = await app.request("/v1/grants/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicToken }),
    });
    assert.equal(exchanged.status, 200);
    const { grantId } = (await exchanged.json()) as { grantId: string };
    const grant = (await store.getGrant(grantId)) as Grant;
    assert.equal(grant.provider, "imap");
    assert.equal(grant.email, "me@example.com");
    assert.ok(await vault.getCiphertext(grantId));

    const listed = await app.request(`/v1/grants/${grantId}/messages?limit=2`);
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { messages: Message[]; nextCursor?: string };
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]?.providerMessageId, "3");
    assert.equal(body.messages[0]?.subject, "IMAP 3");
    assert.equal(body.nextCursor, "2");
    assert.equal(JSON.stringify(body).includes(PASSWORD), false);

    const page2 = await app.request(`/v1/grants/${grantId}/messages?limit=2&cursor=2`);
    const body2 = (await page2.json()) as { messages: Message[]; nextCursor?: string };
    assert.equal(body2.messages.length, 1);
    assert.equal(body2.messages[0]?.providerMessageId, "1");
    assert.equal(body2.nextCursor, undefined);
  });

  it("marks the grant needs_reauth on IMAP auth failure and never echoes the password", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const imap = new ImapAdapter({
      transportFactory: async () => {
        throw new Error(`Authentication failed for user with ${PASSWORD}`);
      },
    });
    const now = new Date().toISOString();
    const grant: Grant = {
      id: "grant_imap_bad",
      tenantId: "default",
      externalUserId: "user-1",
      provider: "imap",
      email: "me@example.com",
      status: "active",
      scopes: ["imap.read"],
      createdAt: now,
      updatedAt: now,
    };
    await store.putGrant(grant);
    const secret = imap.prepareSecret({
      host: "imap.example.com",
      user: "me@example.com",
      password: PASSWORD,
    }).secret;
    await vault.seal(secret, { grantId: grant.id, tenantId: grant.tenantId });
    const app = appFor(store, vault, imap);

    const res = await app.request(`/v1/grants/${grant.id}/messages`);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "needs_reauth");
    assert.equal(JSON.stringify(body).includes(PASSWORD), false);
    assert.equal((await store.getGrant(grant.id))?.status, "needs_reauth");
  });

  it("rejects connect when credentials are incomplete", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const app = appFor(store, vault);
    const sessionRes = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalUserId: "user-imap-2",
        redirectUri: "http://localhost:9999/done",
      }),
    });
    const { linkToken } = (await sessionRes.json()) as { linkToken: string };
    const bad = await app.request(`/v1/connect/${linkToken}/imap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "imap.example.com", user: "me@example.com" }),
    });
    assert.equal(bad.status, 400);
    const text = await bad.text();
    assert.equal(text.toLowerCase().includes("password"), false);
  });
});
