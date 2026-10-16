import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { unescapeHtml } from "@inboxlink/connect-ui";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const API_SECRET = "tenant-api-key-test";
const REFRESH = "1//gmail-refresh-token-test";
const EMAIL = "tester@gmail.com";
/** Address the Google stub reports; tests that need another mailbox change it. */
let googleEmail = EMAIL;

let google: Server;
let tokenUrl = "";
let userinfoUrl = "";
let lastTokenBody = "";

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
      lastTokenBody = await readBody(req);
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
      await readBody(req);
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer ya29.test-access") {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: googleEmail }));
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
    const { app, vault, store } = buildApp();
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
    const href = unescapeHtml(
      html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "",
    );
    const authUrl = new URL(href);
    assert.equal(authUrl.origin, "https://accounts.google.com");
    assert.equal(
      authUrl.searchParams.get("redirect_uri"),
      "http://localhost:8787/v1/oauth/gmail/callback",
    );
    const state = authUrl.searchParams.get("state");
    assert.ok(state);
    const codeChallenge = authUrl.searchParams.get("code_challenge");
    assert.ok(codeChallenge);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    const pending = [...store.sessions.values()].find((s) => s.oauthState === state);
    assert.ok(pending?.codeVerifier);
    const codeVerifier = pending.codeVerifier;
    assert.equal(
      createHash("sha256").update(codeVerifier, "ascii").digest("base64url"),
      codeChallenge,
    );

    lastTokenBody = "";
    const callback = await app.request(
      `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 302);
    const tokenParams = new URLSearchParams(lastTokenBody);
    assert.equal(tokenParams.get("code"), "auth-code");
    assert.equal(tokenParams.get("code_verifier"), codeVerifier);
    const completed = store.sessions.get(pending.id);
    assert.equal(completed?.codeVerifier, undefined);
    assert.equal(completed?.oauthState, undefined);
    const redirected = new URL(callback.headers.get("location") ?? "");
    const publicToken = redirected.searchParams.get("public_token");
    assert.ok(publicToken);

    const replay = await app.request(
      `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /could not be finished/i);

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
      const href = unescapeHtml(
        (await connect.text()).match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "",
      );
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

describe("OAuth callback when Google omits refresh_token", () => {
  it("rejects the callback and leaves no grant", async () => {
    const google = createServer((req, res) => {
      if (req.url?.startsWith("/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "ya29.no-refresh",
            expires_in: 3600,
            scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
          }),
        );
        return;
      }
      if (req.url?.startsWith("/userinfo")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ email: EMAIL }));
        return;
      }
      res.writeHead(404);
      res.end();
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
        gmailScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "openid",
          "email",
        ],
        oauthRedirectUri: "http://localhost:8787/v1/oauth/gmail/callback",
        queue: null,
      });
      const created = await app.request("/v1/link/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalUserId: "user-no-refresh",
          redirectUri: "http://localhost:9999/done",
        }),
      });
      assert.equal(created.status, 200);
      const session = (await created.json()) as { linkToken: string; sessionId: string };
      const connect = await app.request(`/v1/connect/${encodeURIComponent(session.linkToken)}`);
      assert.equal(connect.status, 200);
      const href = unescapeHtml(
        (await connect.text()).match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "",
      );
      const state = new URL(href).searchParams.get("state");
      assert.ok(state);

      const callback = await app.request(
        `/v1/oauth/gmail/callback?code=auth-code-no-refresh&state=${encodeURIComponent(state)}`,
      );
      assert.equal(callback.status, 400);
      const html = await callback.text();
      assert.match(html, /Google did not return a refresh token/);
      assert.match(html, /approve Google access again/i);
      assert.match(html, /No grant was created/);
      assert.match(html, /Inbox<span>Link<\/span>/);
      assert.equal(callback.headers.get("location"), null);

      const listed = await app.request("/v1/grants?externalUserId=user-no-refresh");
      assert.equal(listed.status, 200);
      const { grants } = (await listed.json()) as { grants: unknown[] };
      assert.equal(grants.length, 0);

      const stored = await store.getSession(session.sessionId);
      assert.ok(stored);
      assert.equal(stored.status, "pending");
      assert.equal(stored.grantId, undefined);
      assert.equal(stored.publicToken, undefined);
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

describe("Connect page opened twice", () => {
  it("keeps the first page's Google sign-in working (a reload or second tab must not cancel it)", async () => {
    const { app, store } = buildApp();
    const auth = { authorization: `Bearer ${API_SECRET}`, "content-type": "application/json" };
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ externalUserId: "user-twice", redirectUri: "http://localhost:9999/done" }),
    });
    const { linkToken } = (await created.json()) as { linkToken: string };

    const ctaUrl = async () => {
      const res = await app.request(`/v1/connect/${encodeURIComponent(linkToken)}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      return new URL(unescapeHtml(html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? ""));
    };
    const first = await ctaUrl();
    const second = await ctaUrl();
    const state = first.searchParams.get("state");
    assert.ok(state);
    assert.equal(second.searchParams.get("state"), state, "the second visit keeps the state");
    assert.equal(second.searchParams.get("code_challenge"), first.searchParams.get("code_challenge"));

    lastTokenBody = "";
    const callback = await app.request(`/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 302, "the callback from the first page succeeds");
    const verifier = new URLSearchParams(lastTokenBody).get("code_verifier");
    assert.ok(verifier);
    assert.equal(createHash("sha256").update(verifier, "ascii").digest("base64url"), first.searchParams.get("code_challenge"));
    assert.equal([...store.sessions.values()].some((s) => s.oauthState === state), false, "the state is used up");

    const after = await app.request(`/v1/connect/${encodeURIComponent(linkToken)}`);
    assert.notEqual(after.status, 200, "a finished session does not offer Google again");
  });
});

describe("Unknown OAuth state", () => {
  async function openSession(app: ReturnType<typeof buildApp>["app"], externalUserId: string) {
    const created = await app.request("/v1/link/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${API_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ externalUserId, redirectUri: "http://localhost:9999/done?from=settings" }),
    });
    const { linkToken } = (await created.json()) as { linkToken: string };
    const page = await app.request(`/v1/connect/${encodeURIComponent(linkToken)}`);
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /inboxlink_connect_return=/);
    assert.match(setCookie, /Path=\/v1\/oauth/);
    assert.match(setCookie, /HttpOnly/);
    const html = await page.text();
    const cta = new URL(unescapeHtml(html.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? ""));
    const state = cta.searchParams.get("state");
    assert.ok(state);
    return { state, cookie: setCookie.split(";")[0] };
  }

  function restartHref(html: string): string | undefined {
    const raw = html.match(/data-testid="connect-restart" href="([^"]+)"/)?.[1];
    return raw ? unescapeHtml(raw) : undefined;
  }

  it("offers Start again back to the host and leaves the live session usable", async () => {
    const { app, store } = buildApp();
    const { state, cookie } = await openSession(app, "user-unknown-state");

    const bogus = await app.request("/v1/oauth/gmail/callback?code=auth-code&state=not-a-live-state", {
      headers: { cookie },
    });
    assert.equal(bogus.status, 400);
    const html = await bogus.text();
    assert.doesNotMatch(html, /Session mismatch/);
    const href = restartHref(html);
    assert.ok(href, "a Start again button is shown");
    const restart = new URL(href);
    assert.equal(restart.origin + restart.pathname, "http://localhost:9999/done");
    assert.equal(restart.searchParams.get("error"), "connect_restart");
    assert.equal(restart.searchParams.get("from"), "settings", "the host's own query is kept");
    assert.equal(
      [...store.sessions.values()].some((s) => s.oauthState === state),
      true,
      "the unknown state did not consume the live session",
    );

    const real = await app.request(`/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(real.status, 302, "the real Google return still finishes");
    assert.match(real.headers.get("set-cookie") ?? "", /inboxlink_connect_return=;.*Max-Age=0/);
  });

  it("finds the host from the session when it expired while the user was at Google", async () => {
    const { app, store } = buildApp();
    const { state } = await openSession(app, "user-expired-at-google");
    const session = [...store.sessions.values()].find((s) => s.oauthState === state);
    assert.ok(session);
    session.expiresAt = new Date(Date.now() - 1000).toISOString();

    const res = await app.request(`/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 400);
    const href = restartHref(await res.text());
    assert.ok(href);
    assert.equal(new URL(href).searchParams.get("error"), "connect_restart");
  });

  it("shows plain guidance and no button when the host is unknown", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/oauth/gmail/callback?code=auth-code&state=never-issued");
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.equal(restartHref(html), undefined);
    assert.match(html, /Go back to the app that sent you here/);
  });

  it("ignores a remembered host that is not on the redirect allowlist", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/oauth/gmail/callback?code=auth-code&state=never-issued", {
      headers: { cookie: "inboxlink_connect_return=javascript%3Aalert(1)" },
    });
    assert.equal(restartHref(await res.text()), undefined);
  });
});

/** Runs Connect end to end for one host user and returns the exchanged grant id. */
async function connectAs(
  app: ReturnType<typeof buildApp>["app"],
  store: MemoryStore,
  externalUserId: string,
): Promise<string> {
  const auth = { authorization: `Bearer ${API_SECRET}`, "content-type": "application/json" };
  const created = await app.request("/v1/link/sessions", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ externalUserId, redirectUri: "http://localhost:9999/done" }),
  });
  const { linkToken } = (await created.json()) as { linkToken: string };
  const page = await (await app.request(`/v1/connect/${encodeURIComponent(linkToken)}`)).text();
  const href = unescapeHtml(page.match(/data-testid="connect-cta"[^>]*href="([^"]+)"/)?.[1] ?? "");
  const state = new URL(href).searchParams.get("state") ?? "";
  const callback = await app.request(
    `/v1/oauth/gmail/callback?code=auth-code&state=${encodeURIComponent(state)}`,
  );
  assert.equal(callback.status, 302);
  const publicToken = new URL(callback.headers.get("location") ?? "").searchParams.get(
    "public_token",
  );
  const exchanged = await app.request("/v1/grants/exchange", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ publicToken }),
  });
  const { grantId } = (await exchanged.json()) as { grantId: string };
  assert.ok(store.grants.get(grantId));
  return grantId;
}

function cachedMessage(grantId: string, n: number) {
  const at = "2026-10-01T12:00:00.000Z";
  return {
    id: `msg_${grantId}_${n}`,
    grantId,
    providerMessageId: `p${n}`,
    subject: `Subject ${n}`,
    snippet: "",
    from: [{ email: "recruiter@example.com" }],
    to: [{ email: EMAIL }],
    sentAt: at,
    receivedAt: at,
    folderIds: ["INBOX"],
    hasAttachments: false,
  };
}

describe("one live grant per mailbox (#371)", () => {
  const auth = { authorization: `Bearer ${API_SECRET}` };

  it("the same address connected from a second identity replaces the first grant", async () => {
    googleEmail = EMAIL;
    const { app, vault, store } = buildApp();
    const anonGrant = await connectAs(app, store, "anon_7f3c");
    await store.upsertMessages([cachedMessage(anonGrant, 1), cachedMessage(anonGrant, 2)]);

    googleEmail = "Tester@Gmail.com"; // Google's casing can differ between consents.
    const googleGrant = await connectAs(app, store, "google:1234");
    googleEmail = EMAIL;
    assert.notEqual(googleGrant, anonGrant);

    const old = store.grants.get(anonGrant);
    assert.equal(old?.status, "revoked");
    assert.equal(old?.replacedBy, googleGrant);
    assert.equal(old?.externalUserId, "anon_7f3c");
    assert.equal(await vault.getCiphertext(anonGrant), undefined, "old token is gone");
    assert.deepEqual(await store.listMessageIds(anonGrant), [], "old cache is gone");

    const fresh = store.grants.get(googleGrant);
    assert.equal(fresh?.status, "active");
    assert.equal(fresh?.externalUserId, "google:1234", "the new identity owns the mailbox");
    assert.equal(fresh?.replacedBy, undefined);
    assert.ok(await vault.getCiphertext(googleGrant));

    const live = await store.findLiveGrantsByAddress("default", "gmail", EMAIL);
    assert.deepEqual(live.map((g) => g.id), [googleGrant]);

    // The old identity gets a code it can act on, not a 404 it would retry.
    const read = await app.request(`/v1/grants/${anonGrant}/messages`, { headers: auth });
    assert.equal(read.status, 409);
    assert.deepEqual(await read.json(), { error: "grant_replaced" });
    const sync = await app.request(`/v1/grants/${anonGrant}/sync`, {
      method: "POST",
      headers: auth,
    });
    assert.equal(sync.status, 409);
    assert.deepEqual(await sync.json(), { error: "grant_replaced" });

    const listed = await app.request("/v1/grants?externalUserId=anon_7f3c", { headers: auth });
    const { grants } = (await listed.json()) as { grants: Record<string, unknown>[] };
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.status, "revoked");
    assert.equal("replacedBy" in (grants[0] ?? {}), false, "the new grant id is not shown");
  });

  it("a reconnect by the same identity replaces its own earlier grant", async () => {
    googleEmail = EMAIL;
    const { app, vault, store } = buildApp();
    const first = await connectAs(app, store, "user-uuid-1");
    store.grants.get(first)!.status = "needs_reauth"; // the usual reason to reconnect
    const second = await connectAs(app, store, "user-uuid-1");

    assert.equal(store.grants.get(first)?.status, "revoked");
    assert.equal(store.grants.get(first)?.replacedBy, second);
    assert.equal(await vault.getCiphertext(first), undefined);
    assert.equal(store.grants.get(second)?.status, "active");

    const listed = await app.request("/v1/grants?externalUserId=user-uuid-1", { headers: auth });
    const { grants } = (await listed.json()) as { grants: { id: string; status: string }[] };
    assert.deepEqual(
      grants.map((g) => [g.id, g.status]),
      [
        [first, "revoked"],
        [second, "active"],
      ],
    );
  });

  it("still finishes Connect when retiring the old grant fails", async () => {
    googleEmail = EMAIL;
    const { app, store } = buildApp();
    const first = await connectAs(app, store, "user-1");
    store.findLiveGrantsByAddress = async () => {
      throw new Error("db hiccup");
    };
    const second = await connectAs(app, store, "user-2");
    assert.equal(store.grants.get(second)?.status, "active");
    assert.equal(store.grants.get(first)?.status, "active", "left as before; next Connect retries");
  });

  it("leaves other addresses and already revoked grants alone", async () => {
    const { app, vault, store } = buildApp();
    googleEmail = "other@gmail.com";
    const other = await connectAs(app, store, "user-a");
    googleEmail = EMAIL;
    const b = await connectAs(app, store, "user-b");
    const c = await connectAs(app, store, "user-c");
    const bAfterC = { ...store.grants.get(b)! };
    const d = await connectAs(app, store, "user-d");

    assert.equal(store.grants.get(other)?.status, "active");
    assert.ok(await vault.getCiphertext(other));
    // d replaces c (the live one); b, already replaced by c, is not rewritten.
    assert.equal(store.grants.get(c)?.replacedBy, d);
    assert.deepEqual(store.grants.get(b), bAfterC);
    assert.equal(store.grants.get(b)?.replacedBy, c);
    const live = await store.findLiveGrantsByAddress("default", "gmail", EMAIL);
    assert.deepEqual(live.map((g) => g.id), [d]);
  });
});
