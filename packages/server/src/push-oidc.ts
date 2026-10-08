import { createPublicKey, createVerify, type JsonWebKeyInput } from "node:crypto";

/** Google's signing keys for OIDC tokens (Pub/Sub push attaches one per request). */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_SEC = 60;
const JWKS_TTL_MS = 10 * 60_000;

export type PushOidcConfig = {
  /** Expected `aud`. */
  audience: string;
  /** Expected `email` claim: the push subscription's service account. */
  email: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type Jwk = { kid?: string; kty?: string; n?: string; e?: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

/** Test hook. */
export function resetPushOidcCache(): void {
  jwksCache = null;
}

async function loadKeys(
  fetchImpl: typeof fetch,
  now: number,
  forceRefresh: boolean,
): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`jwks_fetch_failed_${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Verify a Google-signed OIDC JWT from a Pub/Sub push subscription (RS256 only).
 * Checks signature, issuer, audience, `email` + `email_verified`, and expiry.
 * Returns false on any failure; never throws.
 */
export async function verifyPubSubOidc(
  authorization: string | undefined,
  config: PushOidcConfig,
): Promise<boolean> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  if (!match?.[1]) return false;
  const parts = match[1].split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodePart<{ alg?: string; kid?: string }>(headerB64);
  const claims = decodePart<{
    iss?: string;
    aud?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
  }>(payloadB64);
  if (!header || !claims || header.alg !== "RS256" || !header.kid) return false;

  const fetchImpl = config.fetchImpl ?? fetch;
  const nowMs = (config.now ?? Date.now)();
  try {
    let keys = await loadKeys(fetchImpl, nowMs, false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      // Key rotation: refetch once before rejecting.
      keys = await loadKeys(fetchImpl, nowMs, true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    const ok = verifier.verify(
      createPublicKey({ key: jwk, format: "jwk" } as JsonWebKeyInput),
      Buffer.from(sigB64, "base64url"),
    );
    if (!ok) return false;
  } catch {
    return false;
  }

  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) return false;
  if (claims.aud !== config.audience) return false;
  if (claims.email !== config.email || claims.email_verified !== true) return false;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < nowMs / 1000) return false;
  return true;
}
