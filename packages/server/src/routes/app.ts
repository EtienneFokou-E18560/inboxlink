import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import type { Grant, TokenVault } from "@inboxlink/core";
import { createPkcePair, newId, randomToken } from "@inboxlink/core";
import { GmailAdapter, GmailApiError } from "@inboxlink/adapters-gmail";
import {
  connectErrorStatus,
  renderConnectErrorPage,
  renderConnectPage,
  renderLandingPage,
} from "@inboxlink/connect-ui";
import { mountDocsHub } from "../docs-hub/mount.js";
import { buildTenantSecrets, parseBearerToken, resolveTenantId } from "../auth.js";
import {
  buildCorsOriginAllowlist,
  toPublicGrant,
  validateExternalUserId,
  validateRedirectUri,
} from "../grants-public.js";
import {
  createPassthroughRateLimiter,
  createRateLimiter,
  type RateLimiter,
} from "../rate-limit.js";
import type { GrantStore } from "../store.js";
import type { QueueHandle } from "../queue/sync-queue.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { parseMessageListFilters } from "../message-filters.js";
import { getAccessTokenCache } from "../access-token-cache.js";
import { markNeedsReauth, openGrantAccessToken } from "../gmail-access.js";
import { applyGmailPushNotification, parsePubSubPushBody } from "../sync/gmail-push.js";
import { renewAllGmailWatches, startOrRenewGmailWatch } from "../sync/gmail-watch.js";
import { drainSyncJobs } from "../queue/sync-queue.js";
import { NEEDS_REAUTH_GUIDANCE, isHealthPath, log } from "../log.js";
import { probeHealth, renderStatusPage } from "../public/index.js";
import {
  emitWebhookSafe,
  type WebhookBus,
} from "../webhooks/deliver.js";
import { timingSafeEqual } from "node:crypto";

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
  /**
   * Soft abuse guard for Connect + host APIs (single and multi).
   * Pass `null` to disable (tests). Omit to use the default in-process limiter.
   */
  rateLimiter?: RateLimiter | null;
  /**
   * Host Connect `redirectUri` origins allowlist (`null` / omit = permissive).
   * When set, session create rejects redirect URIs whose origin is not listed.
   * Also drives browser CORS (never `*`) together with `publicBaseUrl`.
   */
  allowedRedirectOrigins?: string[] | null;
  /**
   * Outbound host webhook bus (Wave C). Omit / null = no delivery.
   * Failures must never fail Connect or sync HTTP responses.
   */
  webhooks?: WebhookBus | null;
  /** Full Pub/Sub topic for Gmail users.watch (`GMAIL_PUBSUB_TOPIC`). */
  gmailPubsubTopic?: string;
  /** Shared secret for Pub/Sub push verification (`GMAIL_PUSH_SECRET`). */
  gmailPushSecret?: string;
  /** Bearer for internal cron routes (`CRON_SECRET`). */
  cronSecret?: string;
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
        createRateLimiter({ windowMs: 60_000, maxRequests: 120 }));

  const corsOrigins = buildCorsOriginAllowlist(
    opts.allowedRedirectOrigins ?? null,
    opts.publicBaseUrl,
  );
  app.use(
    "*",
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : [],
    }),
  );
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = c.req.path;
    const status = c.res.status;
    const contentType = c.res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      applyHtmlSecurityHeaders(c.res.headers);
    }
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
  // `/status` is a human HTML view of the same probe — JSON on `/health` stays canonical.
  const runHealth = () =>
    probeHealth({
      store: opts.store,
      mode: opts.mode,
      storeKind: opts.storeKind,
      queue: opts.queue,
    });

  const healthJson = async (c: Context<AppEnv>) => {
    const result = await runHealth();
    if (!result.body.ok) {
      log.error("health_database_unavailable", { store: result.body.store });
    }
    return c.json(result.body, result.status);
  };

  const healthHtml = async (c: Context<AppEnv>) => {
    const result = await runHealth();
    if (!result.body.ok) {
      log.error("health_database_unavailable", { store: result.body.store });
    }
    return c.html(
      renderStatusPage({ health: result.body, healthJsonHref: "/health" }),
      result.status,
    );
  };

  app.get("/", healthJson);
  app.get("/health", healthJson);
  app.get("/health/", healthJson);
  app.get("/status", healthHtml);
  app.get("/status/", healthHtml);

  /** Developer landing — human HTML; does not replace `/` or `/health` JSON. */
  app.get("/home", (c) => c.html(renderLandingPage()));
  app.get("/home/", (c) => c.html(renderLandingPage()));

  // Public host docs hub (Connect brand + Link-stripe IA). Own module: docs-hub/.
  mountDocsHub(app);

  app.use("/v1/*", async (c, next) => {
    // OAuth browser callback must remain public (state-bound).
    if (c.req.path.startsWith("/v1/oauth/")) {
      return next();
    }
    // Pub/Sub push + cron use their own secrets (not tenant Bearer).
    if (
      c.req.path.startsWith("/v1/internal/gmail/push") ||
      c.req.path.startsWith("/v1/internal/cron/")
    ) {
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
      const limited = rateLimiter.check(`single:${clientKey(c)}`);
      if (!limited.ok) {
        return c.json({ error: "rate_limited" }, 429, {
          "retry-after": String(limited.retryAfterSec),
        });
      }
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

  /**
   * Schema dump for operators. Behind the same `/v1/*` auth as host APIs —
   * Bearer required in `multi` (Production) so `token_vault` / session DDL
   * is not world-readable.
   */
  app.get("/v1/schema.sql", (c) =>
    c.text(SCHEMA_SQL, 200, { "content-type": "application/sql; charset=utf-8" }),
  );

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
    const { codeVerifier, codeChallenge } = createPkcePair();
    session.oauthState = state;
    session.codeVerifier = codeVerifier;
    await opts.store.saveSession(session);
    const redirectUri = oauthRedirectUri(opts);
    const authUrl = opts.gmail.buildAuthorizationUrl({
      state,
      redirectUri,
      scopes: opts.gmailScopes,
      codeChallenge,
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
    const session = await opts.store.consumeOAuthState(state);
    if (!session) {
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
      tokens = await opts.gmail.exchangeAuthorizationCode({
        code,
        redirectUri,
        codeVerifier: session.codeVerifier,
      });
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
    const refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      log.warn("oauth_callback_failed", {
        reason: "missing_refresh_token",
        store: opts.storeKind ?? "memory",
      });
      return c.html(
        renderConnectErrorPage({ kind: "oauth_missing_refresh" }),
        connectErrorStatus("oauth_missing_refresh"),
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
      await opts.vault.seal(refreshToken, {
        grantId,
        tenantId: session.tenantId,
      });
    } catch {
      await opts.store.deleteGrant(grantId, session.tenantId);
      log.error("oauth_vault_seal_failed", { grantId, tenantId: session.tenantId });
      return c.html(
        renderConnectErrorPage({ kind: "vault_failed" }),
        connectErrorStatus("vault_failed"),
      );
    }
    session.oauthState = undefined;
    session.codeVerifier = undefined;
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

    // Host webhook: grant.connected (awaited but never fails Connect).
    await emitWebhookSafe(opts.webhooks, "grant.connected", {
      grantId,
      tenantId: session.tenantId,
      externalUserId: session.externalUserId,
      provider: "gmail",
      email: grant.email,
    });

    // Gmail push watch (best-effort; poll/sync remains the fallback).
    await startOrRenewGmailWatch({
      store: opts.store,
      vault: opts.vault,
      gmail: opts.gmail,
      grant,
      topicName: opts.gmailPubsubTopic,
    });

    // Enqueue bootstrap sync job (drained by cron / deferred invoke).
    if (opts.queue) {
      const { jobId } = await opts.queue.enqueue({
        grantId,
        tenantId: session.tenantId,
        kind: "bootstrap",
        forceBootstrap: true,
      });
      void drainSyncJobs({
        store: opts.store,
        vault: opts.vault,
        gmail: opts.gmail,
        webhooks: opts.webhooks,
        limit: 1,
      }).catch((err) => {
        log.warn("sync_drain_after_connect_failed", {
          jobId,
          error: err instanceof Error ? err.message : "unknown",
        });
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
    getAccessTokenCache().invalidate(grantId);
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

    const sourceRaw = (c.req.query("source") ?? "store").trim().toLowerCase();
    if (sourceRaw !== "store" && sourceRaw !== "live") {
      return c.json({ error: "invalid_source" }, 400);
    }
    const source = sourceRaw as "store" | "live";

    if (source === "store") {
      const offset = parseStoreOffset(cursor);
      if (offset === null) return c.json({ error: "invalid_cursor" }, 400);

      const all = await opts.store.listMessages(grantId);
      // Newest first for the synced read model (store may keep ASC insertion order).
      const sorted = [...all].sort((a, b) => {
        const ta = Date.parse(a.receivedAt) || 0;
        const tb = Date.parse(b.receivedAt) || 0;
        if (tb !== ta) return tb - ta;
        return a.providerMessageId.localeCompare(b.providerMessageId);
      });
      const page = sorted.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < sorted.length ? String(nextOffset) : undefined;
      const syncCursor = await opts.store.getSyncCursor(grantId);
      return c.json({
        messages: page,
        nextCursor,
        source: "store",
        syncedAt: syncCursor?.updatedAt,
        historyId: syncCursor?.value,
      });
    }

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
      return c.json({
        messages: page.messages,
        nextCursor: page.nextCursor,
        source: "live",
      });
    } catch (err) {
      return gmailReadError(opts, ready.grant, err);
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
      return gmailReadError(opts, ready.grant, err);
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

    const enqueued = opts.queue
      ? await opts.queue.enqueue({
          grantId,
          tenantId: grant.tenantId,
          kind: forceBootstrap ? "bootstrap" : "incremental",
          forceBootstrap,
        })
      : {
          jobId: (
            await opts.store.enqueueSyncJob({
              grantId,
              tenantId: grant.tenantId,
              kind: forceBootstrap ? "bootstrap" : "incremental",
              forceBootstrap,
            })
          ).id,
        };

    // Best-effort deferred drain so local/demo don't wait solely on cron.
    void drainSyncJobs({
      store: opts.store,
      vault: opts.vault,
      gmail: opts.gmail,
      webhooks: opts.webhooks,
      limit: 3,
    }).catch((err) => {
      log.warn("sync_drain_deferred_failed", {
        jobId: enqueued.jobId,
        error: err instanceof Error ? err.message : "unknown",
      });
    });

    return c.json(
      {
        jobId: enqueued.jobId,
        grantId,
        status: "queued",
      },
      202,
    );
  });

  app.get("/v1/grants/:grantId/sync/jobs/:jobId", async (c) => {
    const grantId = c.req.param("grantId");
    const jobId = c.req.param("jobId");
    const tenantId = c.get("tenantId");
    const grant = await opts.store.getGrant(grantId);
    if (!grant || grant.tenantId !== tenantId) return c.json({ error: "not_found" }, 404);
    const job = await opts.store.getSyncJob(jobId);
    if (!job || job.grantId !== grantId || job.tenantId !== tenantId) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      jobId: job.id,
      grantId: job.grantId,
      status: job.status,
      kind: job.kind,
      forceBootstrap: job.forceBootstrap,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  });

  /**
   * Gmail Pub/Sub push endpoint. Verify with `GMAIL_PUSH_SECRET` via
   * `?token=` or `X-InboxLink-Push-Secret` (first-cut shared secret).
   * Returns 204 quickly after accept; history apply runs in-request
   * (keep Pub/Sub ack deadline generous / maxDuration ≥ 60s).
   */
  app.post("/v1/internal/gmail/push", async (c) => {
    if (!verifyPushSecret(c.req.header("x-inboxlink-push-secret"), c.req.query("token"), opts.gmailPushSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const notification = parsePubSubPushBody(raw);
    if (!notification) {
      // Ack malformed payloads so Pub/Sub does not retry forever.
      log.warn("gmail_push_parse_failed");
      return c.body(null, 204);
    }
    try {
      const applied = await applyGmailPushNotification({
        store: opts.store,
        vault: opts.vault,
        gmail: opts.gmail,
        webhooks: opts.webhooks,
        notification,
      });
      log.info("gmail_push_applied", {
        status: applied.status,
        grantCount: applied.grantIds.length,
      });
    } catch (err) {
      log.warn("gmail_push_apply_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
      // Still 204 — avoid Pub/Sub retry storms; host can poll POST …/sync.
    }
    return c.body(null, 204);
  });

  /** Daily: renew Gmail users.watch (≤7 day expiry). */
  const renewWatches = async (c: Context<AppEnv>) => {
    if (!verifyCronSecret(c.req.header("authorization"), opts.cronSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const summary = await renewAllGmailWatches({
      store: opts.store,
      vault: opts.vault,
      gmail: opts.gmail,
      topicName: opts.gmailPubsubTopic,
    });
    return c.json({ ok: true, ...summary });
  };
  app.post("/v1/internal/cron/renew-gmail-watches", renewWatches);
  app.get("/v1/internal/cron/renew-gmail-watches", renewWatches);

  /** Drain durable sync_jobs queue (Vercel cron every few minutes). */
  const drainJobs = async (c: Context<AppEnv>) => {
    if (!verifyCronSecret(c.req.header("authorization"), opts.cronSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const summary = await drainSyncJobs({
      store: opts.store,
      vault: opts.vault,
      gmail: opts.gmail,
      webhooks: opts.webhooks,
      limit: 10,
    });
    return c.json({ ok: true, ...summary });
  };
  app.post("/v1/internal/cron/drain-sync-jobs", drainJobs);
  app.get("/v1/internal/cron/drain-sync-jobs", drainJobs);

  return app;
}

function verifyCronSecret(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected?.trim()) return false;
  const token = parseBearerToken(authorization);
  return timingSafeStringEqual(token ?? undefined, expected);
}

function verifyPushSecret(
  header: string | undefined,
  queryToken: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected?.trim()) return false;
  const provided = header?.trim() || queryToken?.trim();
  return timingSafeStringEqual(provided, expected);
}

/** Constant-time string compare; false when either side missing. */
function timingSafeStringEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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
  const access = await openGrantAccessToken({
    store: opts.store,
    vault: opts.vault,
    gmail: opts.gmail,
    grant,
  });
  if (access.ok) return access;
  if (access.error === "needs_reauth") {
    log.warn("grant_needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      reason: "refresh_rejected",
    });
    await emitWebhookSafe(opts.webhooks, "grant.needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      externalUserId: grant.externalUserId,
      provider: grant.provider,
      email: grant.email,
      reason: "refresh_rejected",
    });
    return {
      ok: false,
      error: "needs_reauth",
      status: 409,
      guidance: NEEDS_REAUTH_GUIDANCE,
    };
  }
  return { ok: false, error: access.error, status: 409 };
}

function accessBody(access: GmailAccessFailure): { error: string; guidance?: string } {
  return access.guidance
    ? { error: access.error, guidance: access.guidance }
    : { error: access.error };
}

async function gmailReadError(
  opts: CreateAppOptions,
  grant: Grant,
  err: unknown,
): Promise<Response> {
  if (err instanceof GmailApiError && (err.status === 401 || err.status === 403)) {
    getAccessTokenCache().invalidate(grant.id);
    await markNeedsReauth(opts.store, grant);
    log.warn("grant_needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      reason: "gmail_unauthorized",
      gmailStatus: err.status,
    });
    await emitWebhookSafe(opts.webhooks, "grant.needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      externalUserId: grant.externalUserId,
      provider: grant.provider,
      email: grant.email,
      reason: "gmail_unauthorized",
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

/** Store list cursor is a decimal offset into the synced cache (newest-first). */
function parseStoreOffset(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) return null;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return offset;
}

function isExpired(iso: string): boolean {
  const at = Date.parse(iso);
  return Number.isNaN(at) || at <= Date.now();
}

function clientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip")?.trim() || "unknown";
}

/** Basic browser hardening for Connect / landing / status / docs HTML. */
const HTML_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
].join("; ");

function applyHtmlSecurityHeaders(headers: Headers): void {
  headers.set("Content-Security-Policy", HTML_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
}

