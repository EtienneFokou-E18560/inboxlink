import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Grant, TokenVault } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";
import { GmailAdapter, GmailApiError } from "@inboxlink/adapters-gmail";
import {
  connectErrorStatus,
  renderConnectErrorPage,
  renderConnectPage,
  renderLandingPage,
} from "@inboxlink/connect-ui";
import { buildTenantSecrets, parseBearerToken, resolveTenantId } from "../auth.js";
import { toPublicGrant, validateExternalUserId, validateRedirectUri } from "../grants-public.js";
import {
  createPassthroughRateLimiter,
  createRateLimiter,
  type RateLimiter,
} from "../rate-limit.js";
import type { GrantStore } from "../store.js";
import type { QueueHandle } from "../queue/sync-queue.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { parseMessageListFilters } from "../message-filters.js";
import { syncGmailGrant } from "../sync/gmail-sync.js";
import {
  DATABASE_UNAVAILABLE_GUIDANCE,
  MEMORY_STORE_GUIDANCE,
  NEEDS_REAUTH_GUIDANCE,
  isHealthPath,
  log,
} from "../log.js";

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
  publicBaseUrl: string;
  /** Bearer secret for the default tenant (backward compatible). */
  apiSecret: string;
  /** Optional tenantId → secret map for multi-host deployments. */
  tenantSecrets?: Record<string, string>;
  /** Tenant bound to `apiSecret` when not listed in `tenantSecrets`. */
  tenantId?: string;
  mode: "single" | "multi";
  gmailScopes: string[];
  /** Registered Google redirect. Defaults to `{publicBaseUrl}/v1/oauth/gmail/callback`. */
  oauthRedirectUri?: string;
  /** `postgres` when DATABASE_URL is set; otherwise process memory. */
  storeKind?: "memory" | "postgres";
  queue: QueueHandle | null;
  /** Soft abuse guard. Pass `null` to disable (tests). Multi mode enables a default limiter. */
  rateLimiter?: RateLimiter | null;
  /**
   * Host Connect `redirectUri` origins allowlist (`null` / omit = permissive).
   * When set, session create rejects redirect URIs whose origin is not listed.
   */
  allowedRedirectOrigins?: string[] | null;
};

export function createApp(opts: CreateAppOptions) {
  const app = new Hono<AppEnv>();
  const tenantSecrets =
    opts.tenantSecrets && Object.keys(opts.tenantSecrets).length > 0
      ? opts.tenantSecrets
      : buildTenantSecrets({
          apiSecret: opts.apiSecret,
          tenantId: opts.tenantId,
        });
  const rateLimiter =
    opts.rateLimiter === null
      ? createPassthroughRateLimiter()
      : (opts.rateLimiter ??
        (opts.mode === "multi"
          ? createRateLimiter({ windowMs: 60_000, maxRequests: 120 })
          : createPassthroughRateLimiter()));

  app.use("*", cors());
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = c.req.path;
    const status = c.res.status;
    if (isHealthPath(path) && status < 400) return;
    log.info("http_request", {
      method: c.req.method,
      path,
      status,
      durationMs: Date.now() - started,
      store: opts.storeKind ?? "memory",
    });
  });

  // `/` is what the production URL opens. `/health/` is the same check with a trailing slash.
  const health = async (c: { json: (body: unknown, status?: number) => Response }) => {
    const storeKind = opts.storeKind ?? "memory";
    try {
      await opts.store.ready();
    } catch {
      log.error("health_database_unavailable", { store: storeKind });
      return c.json(
        {
          ok: false,
          service: "inboxlink",
          mode: opts.mode,
          store: storeKind,
          error: "database_unavailable",
          guidance: DATABASE_UNAVAILABLE_GUIDANCE,
        },
        503,
      );
    }
    const body: Record<string, unknown> = {
      ok: true,
      service: "inboxlink",
      mode: opts.mode,
      queue: opts.queue ? "stub" : "disabled",
      store: storeKind,
    };
    if (storeKind !== "postgres") {
      body.warning = "ephemeral_store";
      body.guidance = MEMORY_STORE_GUIDANCE;
    }
    return c.json(body);
  };
  app.get("/", health);
  app.get("/health", health);
  app.get("/health/", health);

  /** Developer landing — human HTML; does not replace `/` or `/health` JSON. */
  app.get("/home", (c) => c.html(renderLandingPage()));
  app.get("/home/", (c) => c.html(renderLandingPage()));

  app.get("/v1/schema.sql", (c) =>
    c.text(SCHEMA_SQL, 200, { "content-type": "application/sql; charset=utf-8" }),
  );

  app.use("/v1/*", async (c, next) => {
    // OAuth browser callback must remain public (state-bound).
    if (c.req.path.startsWith("/v1/oauth/")) {
      return next();
    }
    if (c.req.path.startsWith("/v1/connect/")) {
      const limited = rateLimiter.check(`connect:${clientKey(c)}`);
      if (!limited.ok) {
        return c.json({ error: "rate_limited" }, 429, {
          "retry-after": String(limited.retryAfterSec),
        });
      }
      return next();
    }
    if (opts.mode === "single") {
      c.set("tenantId", opts.tenantId?.trim() || "default");
      return next();
    }

    const token = parseBearerToken(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const tenantId = resolveTenantId(token, tenantSecrets);
    if (!tenantId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const limited = rateLimiter.check(`tenant:${tenantId}`);
    if (!limited.ok) {
      return c.json({ error: "rate_limited" }, 429, {
        "retry-after": String(limited.retryAfterSec),
      });
    }
    c.set("tenantId", tenantId);
    return next();
  });

  app.post("/v1/link/sessions", async (c) => {
    const body = (await c.req.json()) as {
      externalUserId?: string;
      redirectUri?: string;
      products?: string[];
    };
    const externalUserId = validateExternalUserId(body.externalUserId);
    const redirectUri = validateRedirectUri(
      body.redirectUri,
      opts.allowedRedirectOrigins ?? null,
    );
    if (!externalUserId || !redirectUri) {
      const basicOk = Boolean(
        body.redirectUri && validateRedirectUri(body.redirectUri, null),
      );
      if (externalUserId && basicOk && opts.allowedRedirectOrigins?.length) {
        return c.json(
          {
            error: "redirectUri_not_allowed",
            detail:
              "redirectUri origin is not in ALLOWED_REDIRECT_ORIGINS. Use an allowlisted http(s) origin, or leave ALLOWED_REDIRECT_ORIGINS unset for permissive single-tenant demos.",
          },
          400,
        );
      }
      return c.json({ error: "externalUserId and redirectUri are required" }, 400);
    }
    const tenantId = c.get("tenantId");
    const session = await opts.store.createSession({
      tenantId,
      externalUserId,
      redirectUri,
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
    const tenantId = c.get("tenantId");
    const session = await opts.store.getSession(c.req.param("id"));
    if (!session || session.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    return c.json({
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      grantId: session.grantId,
    });
  });

  /** Connect UI — hosted Link page that starts Gmail OAuth. */
  app.get("/v1/connect/:linkToken", async (c) => {
    const session = await opts.store.getSessionByToken(c.req.param("linkToken"));
    if (!session) {
      return c.html(
        renderConnectErrorPage({ kind: "invalid" }),
        connectErrorStatus("invalid"),
      );
    }
    if (isExpired(session.expiresAt) || session.status === "expired") {
      return c.html(
        renderConnectErrorPage({ kind: "expired" }),
        connectErrorStatus("expired"),
      );
    }
    if (session.status !== "pending") {
      const kind = session.status === "completed" ? "session_completed" : "session_other";
      return c.html(
        renderConnectErrorPage({
          kind,
          sessionStatus: session.status,
        }),
        connectErrorStatus(kind),
      );
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
    return c.html(
      renderConnectPage({
        authUrl,
        expiresAt: session.expiresAt,
      }),
    );
  });

  app.get("/v1/oauth/gmail/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      log.warn("oauth_callback_failed", { reason: error, store: opts.storeKind ?? "memory" });
      return c.html(
        renderConnectErrorPage({ kind: "oauth_denied", providerError: error }),
        connectErrorStatus("oauth_denied"),
      );
    }
    if (!code || !state) {
      log.warn("oauth_callback_failed", { reason: "missing_code_or_state" });
      return c.html(
        renderConnectErrorPage({ kind: "oauth_missing" }),
        connectErrorStatus("oauth_missing"),
      );
    }
    const session = await opts.store.findSessionByOAuthState(state);
    if (!session || isExpired(session.expiresAt)) {
      log.warn("oauth_callback_failed", {
        reason: "unknown_oauth_state",
        store: opts.storeKind ?? "memory",
      });
      return c.html(
        renderConnectErrorPage({ kind: "oauth_unknown_state" }),
        connectErrorStatus("oauth_unknown_state"),
      );
    }
    const redirectUri = oauthRedirectUri(opts);
    let tokens;
    try {
      tokens = await opts.gmail.exchangeAuthorizationCode({ code, redirectUri });
    } catch (err) {
      const reason = googleErrorCode(err);
      log.warn("oauth_callback_failed", { reason, store: opts.storeKind ?? "memory" });
      return c.html(
        renderConnectErrorPage({
          kind: "oauth_exchange",
          detail: oauthExchangeHint(reason, redirectUri),
        }),
        connectErrorStatus("oauth_exchange"),
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
      log.error("oauth_vault_seal_failed", { grantId, tenantId: session.tenantId });
      return c.html(
        renderConnectErrorPage({ kind: "vault_failed" }),
        connectErrorStatus("vault_failed"),
      );
    }
    session.oauthState = undefined;
    const publicToken = randomToken(24);
    session.status = "completed";
    session.grantId = grantId;
    session.publicToken = publicToken;
    await opts.store.saveSession(session);
    log.info("oauth_callback_ok", {
      grantId,
      tenantId: session.tenantId,
      provider: "gmail",
      store: opts.storeKind ?? "memory",
    });

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
    const tenantId = c.get("tenantId");
    const grantId = await opts.store.consumePublicToken(body.publicToken, tenantId);
    if (!grantId) return c.json({ error: "invalid_public_token" }, 400);
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) {
      return c.json({ error: "invalid_public_token" }, 400);
    }
    return c.json({ grantId });
  });

  app.get("/v1/grants", async (c) => {
    const externalUserId = validateExternalUserId(c.req.query("externalUserId"));
    if (!externalUserId) return c.json({ error: "externalUserId required" }, 400);
    const tenantId = c.get("tenantId");
    const grants = await opts.store.listGrants(tenantId, externalUserId);
    return c.json({ grants: grants.map(toPublicGrant) });
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
    const ready = await readyGmailGrant(opts, grantId, tenantId);
    if (!ready.ok) return c.json({ error: ready.error }, ready.status);

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "invalid_limit" }, 400);
    const cursor = c.req.query("cursor")?.trim() || undefined;
    if (cursor && cursor.length > 512) return c.json({ error: "invalid_cursor" }, 400);

    const parsedFilters = parseMessageListFilters({
      q: c.req.query("q") ?? undefined,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      subject: c.req.query("subject") ?? undefined,
      labels: c.req.queries("label") ?? [],
      includeSpamTrash: c.req.query("includeSpamTrash") ?? undefined,
    });
    if (!parsedFilters.ok) return c.json({ error: parsedFilters.error }, 400);

    const access = await openGmailAccess(opts, ready.grant);
    if (!access.ok) return c.json(accessBody(access), access.status);

    try {
      const page = await opts.gmail.listMessages({
        accessToken: access.accessToken,
        grantId,
        maxResults: limit,
        pageToken: cursor,
        q: parsedFilters.filters.q,
        labelIds: parsedFilters.filters.labelIds,
        includeSpamTrash: parsedFilters.filters.includeSpamTrash,
      });
      return c.json({ messages: page.messages, nextCursor: page.nextCursor });
    } catch (err) {
      return gmailReadError(opts.store, ready.grant, err);
    }
  });

  app.get("/v1/grants/:grantId/messages/:messageId", async (c) => {
    const grantId = c.req.param("grantId");
    const tenantId = c.get("tenantId");
    const providerMessageId = resolveProviderMessageId(c.req.param("messageId"));
    if (!providerMessageId) return c.json({ error: "invalid_message_id" }, 400);

    const ready = await readyGmailGrant(opts, grantId, tenantId);
    if (!ready.ok) return c.json({ error: ready.error }, ready.status);

    const access = await openGmailAccess(opts, ready.grant);
    if (!access.ok) return c.json(accessBody(access), access.status);

    try {
      const message = await opts.gmail.getMessage({
        accessToken: access.accessToken,
        grantId,
        messageId: providerMessageId,
      });
      if (!message) return c.json({ error: "not_found" }, 404);
      return c.json({ message });
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) {
        return c.json({ error: "not_found" }, 404);
      }
      return gmailReadError(opts.store, ready.grant, err);
    }
  });

  app.post("/v1/grants/:grantId/sync", async (c) => {
    const grantId = c.req.param("grantId");
    const tenantId = c.get("tenantId");
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    if (grant.provider !== "gmail") return c.json({ error: "unsupported_provider" }, 400);
    if (grant.status !== "active") return c.json({ error: "grant_inactive" }, 409);

    let forceBootstrap = false;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = (await c.req.json()) as { mode?: string };
        forceBootstrap = body.mode === "full" || body.mode === "bootstrap";
      } catch {
        /* empty body is fine */
      }
    }

    // Inline sync (no Redis). Optional queue enqueue is fire-and-forget only.
    if (opts.queue) {
      await opts.queue.enqueue({
        grantId,
        tenantId: grant.tenantId,
        kind: forceBootstrap ? "bootstrap" : "incremental",
      });
    }

    const result = await syncGmailGrant({
      store: opts.store,
      vault: opts.vault,
      gmail: opts.gmail,
      grant,
      forceBootstrap,
    });

    if (result.status === "needs_reauth") {
      return c.json(
        {
          grantId,
          status: "needs_reauth",
          mode: result.mode,
          error: result.error ?? "needs_reauth",
        },
        409,
      );
    }
    if (result.status === "gmail_unavailable") {
      return c.json(
        {
          grantId,
          status: "error",
          mode: result.mode,
          error: "gmail_unavailable",
        },
        502,
      );
    }

    return c.json({
      grantId,
      status: "ok",
      mode: result.mode,
      historyId: result.historyId,
      upserted: result.upserted,
      deleted: result.deleted,
    });
  });

  return app;
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

async function readyGmailGrant(
  opts: CreateAppOptions,
  grantId: string,
  tenantId: string,
): Promise<{ ok: true; grant: Grant } | { ok: false; error: string; status: 400 | 404 | 409 }> {
  const grant = await opts.store.getGrant(grantId);
  if (!grant || grant.tenantId !== tenantId) return { ok: false, error: "not_found", status: 404 };
  if (grant.provider !== "gmail") return { ok: false, error: "unsupported_provider", status: 400 };
  if (grant.status !== "active") return { ok: false, error: "grant_inactive", status: 409 };
  return { ok: true, grant };
}

type GmailAccessFailure = {
  ok: false;
  error: string;
  status: 409;
  guidance?: string;
};

async function openGmailAccess(
  opts: CreateAppOptions,
  grant: Grant,
): Promise<{ ok: true; accessToken: string } | GmailAccessFailure> {
  const ciphertext = await opts.vault.getCiphertext(grant.id);
  if (!ciphertext) return { ok: false, error: "missing_refresh_token", status: 409 };
  let refreshToken: string;
  try {
    refreshToken = await opts.vault.open(ciphertext, { grantId: grant.id, tenantId: grant.tenantId });
  } catch {
    return { ok: false, error: "missing_refresh_token", status: 409 };
  }
  try {
    const accessToken = (await opts.gmail.refreshAccessToken(refreshToken)).accessToken;
    return { ok: true, accessToken };
  } catch {
    await markNeedsReauth(opts.store, grant);
    log.warn("grant_needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      reason: "refresh_rejected",
    });
    return {
      ok: false,
      error: "needs_reauth",
      status: 409,
      guidance: NEEDS_REAUTH_GUIDANCE,
    };
  }
}

function accessBody(access: GmailAccessFailure): { error: string; guidance?: string } {
  return access.guidance
    ? { error: access.error, guidance: access.guidance }
    : { error: access.error };
}

async function gmailReadError(store: GrantStore, grant: Grant, err: unknown): Promise<Response> {
  if (err instanceof GmailApiError && (err.status === 401 || err.status === 403)) {
    await markNeedsReauth(store, grant);
    log.warn("grant_needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      reason: "gmail_unauthorized",
      gmailStatus: err.status,
    });
    return Response.json({ error: "needs_reauth", guidance: NEEDS_REAUTH_GUIDANCE }, { status: 409 });
  }
  log.warn("gmail_unavailable", {
    grantId: grant.id,
    tenantId: grant.tenantId,
    gmailStatus: err instanceof GmailApiError ? err.status : undefined,
  });
  return Response.json({ error: "gmail_unavailable" }, { status: 502 });
}

/** Accept InboxLink `msg_<gmailId>` or the raw Gmail message id. */
function resolveProviderMessageId(messageId: string): string | null {
  const trimmed = messageId.trim();
  if (!trimmed || trimmed.length > 256) return null;
  if (trimmed.startsWith("msg_")) {
    const id = trimmed.slice(4);
    return id || null;
  }
  return trimmed;
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

function clientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip")?.trim() || "unknown";
}

