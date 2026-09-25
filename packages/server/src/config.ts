import {
  buildTenantSecrets,
  DEV_API_SECRET_PLACEHOLDER,
  parseTenantSecrets,
} from "./auth.js";
import { parseAllowedRedirectOrigins } from "./grants-public.js";

export type ServerConfig = {
  port: number;
  host: string;
  publicBaseUrl: string;
  mode: "single" | "multi";
  masterKey: string;
  apiSecret: string;
  /** Default tenant when only INBOXLINK_API_SECRET is set. */
  tenantId: string;
  /** tenantId → Bearer secret for multi mode. */
  tenantSecrets: Record<string, string>;
  databaseUrl?: string;
  redisUrl?: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  gmailScopes: string[];
  /**
   * Host Connect `redirectUri` origins allowlist.
   * `null` = permissive (any http(s) URL) — default for single-tenant demo.
   */
  allowedRedirectOrigins: string[] | null;
  /** Soft abuse guard for Connect + host APIs (single and multi). */
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? "8787");
  const publicBaseUrl = resolvePublicBaseUrl(env, port);
  // Default stays single — do not flip Production to multi without an explicit ops decision.
  const mode = env.INBOXLINK_MODE === "multi" ? "multi" : "single";
  const masterKey =
    env.INBOXLINK_MASTER_KEY?.trim() || "dev-only-master-key-change-me-32b";
  const apiSecret = env.INBOXLINK_API_SECRET ?? DEV_API_SECRET_PLACEHOLDER;
  const tenantId = env.INBOXLINK_TENANT_ID?.trim() || "default";
  const tenantSecrets = buildTenantSecrets({
    apiSecret,
    tenantId,
    extra: parseTenantSecrets(env.INBOXLINK_TENANT_SECRETS),
  });
  assertMultiModeSecrets(mode, tenantSecrets, env);
  const scopes =
    env.GMAIL_SCOPES?.split(/\s+/).filter(Boolean) ??
    [
      "https://www.googleapis.com/auth/gmail.readonly",
      "openid",
      "email",
    ];

  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicBaseUrl,
    mode,
    masterKey,
    apiSecret,
    tenantId,
    tenantSecrets,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    googleClientId: env.GOOGLE_CLIENT_ID ?? "your-google-client-id.apps.googleusercontent.com",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "your-google-client-secret",
    googleRedirectUri:
      env.GOOGLE_REDIRECT_URI ?? `${publicBaseUrl}/v1/oauth/gmail/callback`,
    gmailScopes: scopes,
    allowedRedirectOrigins: parseAllowedRedirectOrigins(env.ALLOWED_REDIRECT_ORIGINS),
    rateLimitWindowMs: positiveInt(env.INBOXLINK_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMaxRequests: positiveInt(env.INBOXLINK_RATE_LIMIT_MAX, 120),
  };
}

/**
 * Multi mode in a hosted/production environment must not use the committed
 * placeholder secret. Local demos may still use the placeholder.
 */
export function assertMultiModeSecrets(
  mode: "single" | "multi",
  tenantSecrets: Record<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  if (mode !== "multi") return;
  const hosted =
    Boolean(env.VERCEL) ||
    env.NODE_ENV === "production" ||
    env.VERCEL_ENV === "production";
  if (!hosted) return;
  for (const [tenantId, secret] of Object.entries(tenantSecrets)) {
    if (!secret || secret === DEV_API_SECRET_PLACEHOLDER) {
      throw new Error(
        `INBOXLINK_MODE=multi requires a non-default Bearer secret for tenant "${tenantId}" (set INBOXLINK_API_SECRET / INBOXLINK_TENANT_SECRETS). Default mode remains single until you explicitly enable multi.`,
      );
    }
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Prefer an explicit public URL, then the stable Vercel production host. */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const production = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const vercel = env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return `http://localhost:${port}`;
}
