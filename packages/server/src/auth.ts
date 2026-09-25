import { timingSafeEqual } from "node:crypto";

/**
 * Parse a strict HTTP Bearer credential.
 * Rejects missing headers, non-Bearer schemes (e.g. Basic), empty tokens,
 * and values with embedded whitespace after the scheme.
 */
export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match?.[1]) return null;
  return match[1];
}

export function safeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve which tenant a Bearer token belongs to.
 * Compares against every configured secret (no early return on match)
 * so timing does not short-circuit on the first hit.
 */
export function resolveTenantId(
  token: string,
  tenantSecrets: Readonly<Record<string, string>>,
): string | undefined {
  let matched: string | undefined;
  for (const [tenantId, secret] of Object.entries(tenantSecrets)) {
    if (!secret) continue;
    if (safeEqualString(token, secret)) matched = tenantId;
  }
  return matched;
}

/** Built-in placeholder — never acceptable for multi mode in production. */
export const DEV_API_SECRET_PLACEHOLDER = "dev-api-secret-change-me";

/**
 * Parse `tenantId=secret` pairs from env.
 * Separators: commas or newlines. Secrets may contain `=` after the first one.
 */
export function parseTenantSecrets(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const tenantId = trimmed.slice(0, eq).trim();
    const secret = trimmed.slice(eq + 1).trim();
    if (tenantId && secret) out[tenantId] = secret;
  }
  return out;
}

export function buildTenantSecrets(input: {
  apiSecret: string;
  tenantId?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const defaultTenant = input.tenantId?.trim() || "default";
  return {
    [defaultTenant]: input.apiSecret,
    ...(input.extra ?? {}),
  };
}
