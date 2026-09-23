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

export function validateRedirectUri(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REDIRECT_URI) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return trimmed;
  } catch {
    return null;
  }
}
