import type { Grant } from "@inboxlink/core";

/** Host-facing grant shape — omits tenantId / externalUserId. */
export type PublicGrant = {
  id: string;
  provider: Grant["provider"];
  email: string;
  status: Grant["status"];
  scopes: string[];
  createdAt: string;
  updatedAt: string;
};

export function toPublicGrant(grant: Grant): PublicGrant {
  return {
    id: grant.id,
    provider: grant.provider,
    email: grant.email,
    status: grant.status,
    scopes: grant.scopes,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

const MAX_EXTERNAL_USER_ID = 256;
const MAX_REDIRECT_URI = 2048;

export function validateExternalUserId(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_USER_ID) return null;
  return trimmed;
}

/**
 * Parse `ALLOWED_REDIRECT_ORIGINS` (comma / whitespace separated http(s) URLs).
 * Returns `null` when unset or empty → permissive (any http(s) redirectUri).
 * When set, each entry’s origin (scheme+host+port) is allowlisted.
 * Invalid entries throw so misconfiguration fails closed at boot.
 */
export function parseAllowedRedirectOrigins(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const origins: string[] = [];
  for (const part of parts) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      throw new Error(
        `ALLOWED_REDIRECT_ORIGINS entry is not a valid absolute URL (include http:// or https://): ${part}`,
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`ALLOWED_REDIRECT_ORIGINS entry must use http or https: ${part}`);
    }
    origins.push(url.origin);
  }
  return origins;
}

export function validateRedirectUri(
  value: string | undefined,
  allowedOrigins: string[] | null = null,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REDIRECT_URI) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (!allowedOrigins.includes(url.origin)) return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}
