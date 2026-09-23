import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Grant, TokenVault } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";
import { GmailAdapter, GmailApiError } from "@inboxlink/adapters-gmail";
import {
  ImapAdapter,
  ImapAuthError,
  ImapCredentialsError,
  ImapUnavailableError,
} from "@inboxlink/adapters-imap";
import type { GrantStore } from "../store.js";
import type { QueueHandle } from "../queue/sync-queue.js";
import { SCHEMA_SQL } from "../db/schema.js";

export type AppEnv = {
  Variables: {
    tenantId: string;
  };
};

export type CreateAppOptions = {
  store: GrantStore;
  vault: TokenVault & {
    getCiphertext(grantId: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  };
  gmail: GmailAdapter;
  /** Optional; defaults to a real imapflow-backed adapter when omitted. */
  imap?: ImapAdapter;
  publicBaseUrl: string;
  apiSecret: string;
  mode: "single" | "multi";
  gmailScopes: string[];
  /** Registered Google redirect. Defaults to `{publicBaseUrl}/v1/oauth/gmail/callback`. */
  oauthRedirectUri?: string;
  /** `postgres` when DATABASE_URL is set; otherwise process memory. */
  storeKind?: "memory" | "postgres";
  queue: QueueHandle | null;
};

export function createApp(opts: CreateAppOptions) {
  const app = new Hono<AppEnv>();
  const imap = opts.imap ?? new ImapAdapter();

  app.use("*", cors());

  // `/` is what the production URL opens. `/health/` is the same check with a trailing slash.
  const health = async (c: { json: (body: unknown, status?: number) => Response }) => {
    const storeKind = opts.storeKind ?? "memory";
    try {
      await opts.store.ready();
    } catch {
      return c.json(
        { ok: false, service: "inboxlink", mode: opts.mode, store: storeKind, error: "database_unavailable" },
        503,
      );
    }
    return c.json({
      ok: true,
      service: "inboxlink",
      mode: opts.mode,
      queue: opts.queue ? "stub" : "disabled",
      store: storeKind,
    });
  };
  app.get("/", health);
  app.get("/health", health);
  app.get("/health/", health);

  app.get("/v1/schema.sql", (c) =>
    c.text(SCHEMA_SQL, 200, { "content-type": "application/sql; charset=utf-8" }),
  );

  app.use("/v1/*", async (c, next) => {
    // OAuth browser callback must remain public (state-bound).
    if (c.req.path.startsWith("/v1/oauth/")) {
      return next();
    }
    if (c.req.path.startsWith("/v1/connect/")) {
      return next();
    }
    if (opts.mode === "single") {
      c.set("tenantId", "default");
      return next();
    }
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeEqual(token, opts.apiSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("tenantId", "default");
    return next();
  });

  app.post("/v1/link/sessions", async (c) => {
    const body = (await c.req.json()) as {
      externalUserId?: string;
      redirectUri?: string;
      products?: string[];
    };
    if (!body.externalUserId || !body.redirectUri) {
      return c.json({ error: "externalUserId and redirectUri are required" }, 400);
    }
    const tenantId = c.get("tenantId");
    const session = await opts.store.createSession({
      tenantId,
      externalUserId: body.externalUserId,
      redirectUri: body.redirectUri,
      products: body.products ?? ["messages"],
    });
    const connectUrl = new URL(
      `/v1/connect/${encodeURIComponent(session.linkToken)}`,
      opts.publicBaseUrl,
    ).toString();
    return c.json({
      sessionId: session.id,
      linkToken: session.linkToken,
      connectUrl,
      expiresAt: session.expiresAt,
    });
  });

  app.get("/v1/link/sessions/:id", async (c) => {
    const session = await opts.store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    return c.json({
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      grantId: session.grantId,
    });
  });

  /** Minimal Connect stub — Gmail OAuth + IMAP password/app-password form. */
  app.get("/v1/connect/:linkToken", async (c) => {
    const session = await opts.store.getSessionByToken(c.req.param("linkToken"));
    if (!session || isExpired(session.expiresAt)) {
      return c.html("<h1>Invalid or expired link</h1>", 404);
    }
    if (session.status !== "pending") {
      return c.html(`<h1>Session ${session.status}</h1>`, 400);
    }
    const state = randomToken(16);
    session.oauthState = state;
    await opts.store.saveSession(session);
    const redirectUri = oauthRedirectUri(opts);
    const authUrl = opts.gmail.buildAuthorizationUrl({
      state,
      redirectUri,
      scopes: opts.gmailScopes,
    });
    const linkToken = encodeURIComponent(session.linkToken);
    return c.html(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>InboxLink Connect</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
  a.button,button{display:inline-block;background:#111;color:#fff;padding:.75rem 1.25rem;border-radius:8px;text-decoration:none;border:0;cursor:pointer;font:inherit}
  label{display:block;margin:.75rem 0 .25rem;font-size:.9rem}
  input{width:100%;padding:.5rem;box-sizing:border-box}
  .muted{color:#555;font-size:.9rem}
  hr{border:0;border-top:1px solid #ddd;margin:2rem 0}
</style></head>
<body>
  <h1>Connect inbox</h1>
  <p>InboxLink will request <strong>read-only</strong> Gmail access. Your host app never sees the refresh token.</p>
  <p><a class="button" href="${escapeHtml(authUrl)}">Continue with Google</a></p>
  <hr/>
  <h2>IMAP (password / app-password)</h2>
  <p class="muted">Credentials are sealed in the vault. Prefer an app-password. INBOX list only in v0.</p>
  <form method="post" action="/v1/connect/${linkToken}/imap">
    <label for="host">IMAP host</label>
    <input id="host" name="host" required placeholder="imap.example.com" autocomplete="off"/>
    <label for="port">Port</label>
    <input id="port" name="port" type="number" value="993" min="1" max="65535"/>
    <label for="secure"><input id="secure" name="secure" type="checkbox" value="true" checked/> Use TLS (IMAPS)</label>
    <label for="user">Username</label>
    <input id="user" name="user" required autocomplete="username"/>
    <label for="password">Password / app-password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password"/>
    <p style="margin-top:1.25rem"><button type="submit">Connect IMAP</button></p>
  </form>
  <p class="muted">Stub Connect UI — replace with packages/connect-ui.</p>
</body></html>`);
  });

  /** IMAP connect — verifies login, seals credentials, completes the link session. */
  app.post("/v1/connect/:linkToken/imap", async (c) => {
    const session = await opts.store.getSessionByToken(c.req.param("linkToken"));
    if (!session || isExpired(session.expiresAt)) {
      return c.html("<h1>Invalid or expired link</h1>", 404);
    }
    if (session.status !== "pending") {
      return c.html(`<h1>Session ${session.status}</h1>`, 400);
    }

    const contentType = c.req.header("content-type") ?? "";
    let body: unknown;
    try {
      if (contentType.includes("application/json")) {
        body = await c.req.json();
      } else {
        const form = await c.req.parseBody();
        body = {
          host: form.host,
          port: form.port,
          secure: form.secure === "true" || form.secure === "on" ? true : form.secure === "false" ? false : undefined,
          user: form.user,
          password: form.password,
        };
      }
    } catch {
      return c.html("<h1>Invalid IMAP form</h1>", 400);
    }

    let prepared: ReturnType<ImapAdapter["prepareSecret"]>;
    try {
      prepared = imap.prepareSecret(body);
    } catch (err) {
      if (err instanceof ImapCredentialsError) {
        return c.html(`<h1>Invalid IMAP credentials</h1><p>${escapeHtml(err.message)}</p>`, 400);
      }
      return c.html("<h1>Invalid IMAP credentials</h1>", 400);
    }

    let email: string;
    try {
      email = (await imap.verifyConnection(prepared.credentials)).email;
    } catch (err) {
      if (err instanceof ImapAuthError) {
        return c.html(
          "<h1>IMAP login failed</h1><p>Check the host, username, and password or app-password.</p>",
          401,
        );
      }
      return c.html(
        "<h1>IMAP unavailable</h1><p>Could not reach the mailbox. Check host, port, and TLS.</p>",
        502,
      );
    }

    const grantId = newId("grant");
    const now = new Date().toISOString();
    const grant: Grant = {
      id: grantId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      provider: "imap",
      email,
      status: "active",
      scopes: ["imap.read"],
      createdAt: now,
      updatedAt: now,
    };
    await opts.store.putGrant(grant);
    try {
      await opts.vault.seal(prepared.secret, {
        grantId,
        tenantId: session.tenantId,
      });
    } catch {
      await opts.store.deleteGrant(grantId, session.tenantId);
      return c.html(
        "<h1>Could not store IMAP credentials</h1><p>Set INBOXLINK_MASTER_KEY to at least 16 characters, redeploy, and start Connect again.</p>",
        500,
      );
    }

    session.oauthState = undefined;
    const publicToken = randomToken(24);
    session.status = "completed";
    session.grantId = grantId;
    session.publicToken = publicToken;
    await opts.store.saveSession(session);

    if (opts.queue) {
      await opts.queue.enqueue({
        grantId,
        tenantId: session.tenantId,
        kind: "bootstrap",
      });
    }

    const redirect = new URL(session.redirectUri);
    redirect.searchParams.set("public_token", publicToken);
    redirect.searchParams.set("link_token", session.linkToken);
    return c.redirect(redirect.toString(), 302);
  });

  app.get("/v1/oauth/gmail/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      return c.html(`<h1>OAuth error</h1><pre>${escapeHtml(error)}</pre>`, 400);
    }
    if (!code || !state) {
      return c.html("<h1>Missing code/state</h1>", 400);
    }
    const session = await opts.store.findSessionByOAuthState(state);
    if (!session || isExpired(session.expiresAt)) {
      return c.html("<h1>Unknown OAuth state</h1>", 400);
    }
    const redirectUri = oauthRedirectUri(opts);
    let tokens;
    try {
      tokens = await opts.gmail.exchangeAuthorizationCode({ code, redirectUri });
    } catch (err) {
      const reason = googleErrorCode(err);
      return c.html(
        `<h1>Google token exchange failed</h1><p>${escapeHtml(oauthExchangeHint(reason, redirectUri))}</p>`,
        400,
      );
    }
    const grantId = newId("grant");
    const now = new Date().toISOString();
    const grant: Grant = {
      id: grantId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      provider: "gmail",
      email: tokens.email ?? "unknown@gmail.com",
      status: "active",
      scopes: tokens.scopes.length ? tokens.scopes : [...opts.gmailScopes],
      createdAt: now,
      updatedAt: now,
    };
    await opts.store.putGrant(grant);
    try {
      if (tokens.refreshToken) {
        await opts.vault.seal(tokens.refreshToken, {
          grantId,
          tenantId: session.tenantId,
        });
      }
    } catch {
      await opts.store.deleteGrant(grantId, session.tenantId);
      return c.html(
        "<h1>Could not store the refresh token</h1><p>Set INBOXLINK_MASTER_KEY to at least 16 characters, redeploy, and start Connect again.</p>",
        500,
      );
    }
    session.oauthState = undefined;
    const publicToken = randomToken(24);
    session.status = "completed";
    session.grantId = grantId;
    session.publicToken = publicToken;
    await opts.store.saveSession(session);

    if (opts.queue) {
      await opts.queue.enqueue({
        grantId,
        tenantId: session.tenantId,
        kind: "bootstrap",
      });
    }

    const redirect = new URL(session.redirectUri);
    redirect.searchParams.set("public_token", publicToken);
    redirect.searchParams.set("link_token", session.linkToken);
    return c.redirect(redirect.toString(), 302);
  });

  app.post("/v1/grants/exchange", async (c) => {
    const body = (await c.req.json()) as { publicToken?: string };
    if (!body.publicToken) return c.json({ error: "publicToken required" }, 400);
    const grantId = await opts.store.consumePublicToken(body.publicToken);
    if (!grantId) return c.json({ error: "invalid_public_token" }, 400);
    return c.json({ grantId });
  });

  app.get("/v1/grants", async (c) => {
    const externalUserId = c.req.query("externalUserId");
    if (!externalUserId) return c.json({ error: "externalUserId required" }, 400);
    const tenantId = c.get("tenantId");
    const grants = await opts.store.listGrants(tenantId, externalUserId);
    return c.json({ grants });
  });

  app.delete("/v1/grants/:grantId", async (c) => {
    const grantId = c.req.param("grantId");
    const tenantId = c.get("tenantId");
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    await opts.vault.destroy(grantId);
    await opts.store.deleteGrant(grantId, tenantId);
    await opts.store.deleteMessages(grantId);
    return c.body(null, 204);
  });

  app.get("/v1/grants/:grantId/messages", async (c) => {
    const grantId = c.req.param("grantId");
    const tenantId = c.get("tenantId");
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    if (grant.provider !== "gmail" && grant.provider !== "imap") {
      return c.json({ error: "unsupported_provider" }, 400);
    }
    if (grant.status !== "active") return c.json({ error: "grant_inactive" }, 409);

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "invalid_limit" }, 400);
    const cursor = c.req.query("cursor")?.trim() || undefined;
    if (cursor && cursor.length > 512) return c.json({ error: "invalid_cursor" }, 400);

    if (grant.provider === "imap") {
      return listImapMessages(c, opts, imap, grant, limit, cursor);
    }

    const ciphertext = await opts.vault.getCiphertext(grantId);
    if (!ciphertext) return c.json({ error: "missing_refresh_token" }, 409);
    let refreshToken: string;
    try {
      refreshToken = await opts.vault.open(ciphertext, { grantId, tenantId: grant.tenantId });
    } catch {
      return c.json({ error: "missing_refresh_token" }, 409);
    }

    let accessToken: string;
    try {
      accessToken = (await opts.gmail.refreshAccessToken(refreshToken)).accessToken;
    } catch {
      await markNeedsReauth(opts.store, grant);
      return c.json({ error: "needs_reauth" }, 409);
    }

    try {
      const page = await opts.gmail.listMessages({
        accessToken,
        grantId,
        maxResults: limit,
        pageToken: cursor,
      });
      return c.json({ messages: page.messages, nextCursor: page.nextCursor });
    } catch (err) {
      if (err instanceof GmailApiError && (err.status === 401 || err.status === 403)) {
        await markNeedsReauth(opts.store, grant);
        return c.json({ error: "needs_reauth" }, 409);
      }
      return c.json({ error: "gmail_unavailable" }, 502);
    }
  });

  app.post("/v1/grants/:grantId/sync", async (c) => {
    const grantId = c.req.param("grantId");
    const tenantId = c.get("tenantId");
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    if (opts.queue) {
      await opts.queue.enqueue({
        grantId,
        tenantId: grant.tenantId,
        kind: "incremental",
      });
    }
    return c.json({
      grantId,
      status: "accepted",
      note: "Read messages with GET /v1/grants/:grantId/messages. History sync is not implemented.",
    });
  });

  return app;
}

async function listImapMessages(
  c: { json: (body: unknown, status?: number) => Response },
  opts: CreateAppOptions,
  imap: ImapAdapter,
  grant: Grant,
  limit: number,
  cursor: string | undefined,
): Promise<Response> {
  const ciphertext = await opts.vault.getCiphertext(grant.id);
  if (!ciphertext) return c.json({ error: "missing_imap_secret" }, 409);
  let secret: string;
  try {
    secret = await opts.vault.open(ciphertext, { grantId: grant.id, tenantId: grant.tenantId });
  } catch {
    return c.json({ error: "missing_imap_secret" }, 409);
  }

  let credentials;
  try {
    credentials = imap.openSecret(secret);
  } catch {
    await markNeedsReauth(opts.store, grant);
    return c.json({ error: "needs_reauth" }, 409);
  }

  try {
    const page = await imap.listMessages({
      credentials,
      grantId: grant.id,
      maxResults: limit,
      cursor,
    });
    return c.json({ messages: page.messages, nextCursor: page.nextCursor });
  } catch (err) {
    if (err instanceof ImapAuthError) {
      await markNeedsReauth(opts.store, grant);
      return c.json({ error: "needs_reauth" }, 409);
    }
    if (err instanceof ImapUnavailableError && err.message === "invalid_cursor") {
      return c.json({ error: "invalid_cursor" }, 400);
    }
    return c.json({ error: "imap_unavailable" }, 502);
  }
}

function googleErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const match = message.match(/"error"\s*:\s*"([a-z0-9_]+)"/i);
  return match?.[1] ?? "exchange_failed";
}

function oauthExchangeHint(code: string, redirectUri: string): string {
  switch (code) {
    case "invalid_client":
      return "Google rejected the OAuth client. Replace GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET with the web client values, redeploy, and start Connect again.";
    case "redirect_uri_mismatch":
      return `Add this exact redirect in the Google OAuth client: ${redirectUri}`;
    case "invalid_grant":
      return "The Google code expired or was already used. Start Connect again.";
    default:
      return "Google did not accept the authorization code. Check the OAuth client and redirect URI, redeploy, and start Connect again.";
  }
}

function oauthRedirectUri(opts: CreateAppOptions): string {
  return (
    opts.oauthRedirectUri ??
    new URL("/v1/oauth/gmail/callback", opts.publicBaseUrl).toString()
  );
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value === "") return 20;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  if (limit < 1 || limit > 25) return null;
  return limit;
}

async function markNeedsReauth(store: GrantStore, grant: Grant): Promise<void> {
  grant.status = "needs_reauth";
  grant.updatedAt = new Date().toISOString();
  await store.updateGrant(grant);
}

function isExpired(iso: string): boolean {
  const at = Date.parse(iso);
  return Number.isNaN(at) || at <= Date.now();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
