export type ServerConfig = {
  port: number;
  host: string;
  publicBaseUrl: string;
  mode: "single" | "multi";
  masterKey: string;
  apiSecret: string;
  databaseUrl?: string;
  redisUrl?: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  gmailScopes: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT ?? "8787");
  const publicBaseUrl = resolvePublicBaseUrl(env, port);
  const mode = env.INBOXLINK_MODE === "multi" ? "multi" : "single";
  const masterKey =
    env.INBOXLINK_MASTER_KEY?.trim() || "dev-only-master-key-change-me-32b";
  const apiSecret = env.INBOXLINK_API_SECRET ?? "dev-api-secret-change-me";
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
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    googleClientId: env.GOOGLE_CLIENT_ID ?? "your-google-client-id.apps.googleusercontent.com",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "your-google-client-secret",
    googleRedirectUri:
      env.GOOGLE_REDIRECT_URI ?? `${publicBaseUrl}/v1/oauth/gmail/callback`,
    gmailScopes: scopes,
  };
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
