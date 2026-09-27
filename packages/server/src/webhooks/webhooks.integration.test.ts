import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { createApp } from "../routes/app.js";
import { MemoryStore } from "../store.js";
import { MemoryTokenVault } from "../vault/memory-vault.js";
import { createWebhookBus, type WebhookEvent } from "./deliver.js";

const API_SECRET = "tenant-api-key-webhook";
const REFRESH = "1//gmail-refresh-webhook";

let google: Server;
let tokenUrl = "";
let userinfoUrl = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

before(async () => {
  google = createServer(async (req, res) => {
    if (req.url?.startsWith("/token")) {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "ya29.webhook-access",
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
        }),
      );
      return;
    }
    if (req.url?.startsWith("/userinfo")) {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: "webhook@gmail.com" }));
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

describe("Wave C — Connect survives webhook failure", () => {
  it("OAuth callback still redirects when webhook delivery fails hard", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault("test-master-key-at-least-16");
    const gmail = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
      tokenUrl,
      userinfoUrl,
    });
    let hookCalls = 0;
    const webhooks = createWebhookBus({
      url: "https://hooks.example/always-fail",
      secret: "whsec-connect",
      maxAttempts: 2,
      sleep: async () => {},
      fetchImpl: async () => {
        hookCalls += 1;
        return new Response("gone", { status: 410 });
      },
    });
    const app = createApp({
      store,
      vault,
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: API_SECRET,
      mode: "multi",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
      queue: null,
      rateLimiter: null,
      webhooks,
    });

    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        externalUserId: "webhook-user",
        redirectUri: "http://127.0.0.1:9999/done",
      }),
    });
    assert.equal(created.status, 200);
    const session = (await created.json()) as { linkToken: string; connectUrl: string };
    const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    const html = await connect.text();
    const href = html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "";
    const state = new URL(href.replace(/&amp;/g, "&")).searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    const location = callback.headers.get("location") ?? "";
    assert.match(location, /public_token=/);
    assert.equal(hookCalls, 1);
    assert.ok([...store.grants.values()].some((g) => g.status === "active"));
  });

  it("emits grant.connected with a verifiable signature on success", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault("test-master-key-at-least-16");
    const gmail = new GmailAdapter({
      clientId: "test-client-id.apps.googleusercontent.com",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
      tokenUrl,
      userinfoUrl,
    });
    const received: { body: string; signature: string; event: string }[] = [];
    const webhooks = createWebhookBus({
      url: "https://hooks.example/ok",
      secret: "whsec-ok",
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        received.push({
          body: String(init?.body ?? ""),
          signature: headers["X-InboxLink-Signature"] ?? "",
          event: headers["X-InboxLink-Event"] ?? "",
        });
        return new Response("ok", { status: 200 });
      },
    });
    const app = createApp({
      store,
      vault,
      gmail,
      publicBaseUrl: "http://localhost:8787",
      apiSecret: API_SECRET,
      mode: "multi",
      gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid", "email"],
      queue: null,
      rateLimiter: null,
      webhooks,
    });

    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        externalUserId: "webhook-user-2",
        redirectUri: "http://127.0.0.1:9999/done",
      }),
    });
    const session = (await created.json()) as { linkToken: string };
    const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
    const html = await connect.text();
    const href = html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "";
    const state = new URL(href.replace(/&amp;/g, "&")).searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/v1/oauth/gmail/callback?code=auth-code-2&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.event, "grant.connected");
    const parsed = JSON.parse(received[0]!.body) as WebhookEvent;
    assert.equal(parsed.type, "grant.connected");
    assert.match(parsed.id, /^evt_/);
    assert.equal(typeof parsed.data.grantId, "string");
  });
});
