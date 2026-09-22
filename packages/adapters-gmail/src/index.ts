import type { MailboxAdapter } from "@inboxlink/core";

export type GmailAdapterConfig = {
  clientId: string;
  clientSecret: string;
  /** Default redirect used when callers omit redirectUri. */
  redirectUri: string;
  authBaseUrl?: string;
  tokenUrl?: string;
};

const DEFAULT_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Gmail OAuth adapter (v0 stub).
 * Builds real authorization URLs and token exchange requests against Google,
 * but does not call Gmail REST until Slice 2. No production secrets are bundled.
 */
export class GmailAdapter implements MailboxAdapter {
  readonly provider = "gmail" as const;

  constructor(private readonly config: GmailAdapterConfig) {}

  buildAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
  }): string {
    const url = new URL(this.config.authBaseUrl ?? DEFAULT_AUTH);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri || this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", input.state);
    if (input.codeChallenge) {
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    email?: string;
    scopes: string[];
  }> {
    const body = new URLSearchParams({
      code: input.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri || this.config.redirectUri,
      grant_type: "authorization_code",
    });
    if (input.codeVerifier) {
      body.set("code_verifier", input.codeVerifier);
    }

    // Stub path: when credentials are placeholders, return a deterministic mock grant.
    if (isPlaceholder(this.config.clientId) || isPlaceholder(this.config.clientSecret)) {
      return {
        accessToken: "stub-access-token",
        refreshToken: "stub-refresh-token",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        email: "stub-user@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      };
    }

    const res = await fetch(this.config.tokenUrl ?? DEFAULT_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt:
        typeof json.expires_in === "number"
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : undefined,
      scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt?: string;
  }> {
    if (isPlaceholder(this.config.clientId) || isPlaceholder(this.config.clientSecret)) {
      return {
        accessToken: "stub-access-token-refreshed",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(this.config.tokenUrl ?? DEFAULT_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Gmail refresh failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: json.access_token,
      expiresAt:
        typeof json.expires_in === "number"
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : undefined,
    };
  }
}

function isPlaceholder(value: string): boolean {
  return (
    !value ||
    value.includes("your-google") ||
    value.includes("change-me") ||
    value.startsWith("replace-")
  );
}

export const DEFAULT_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
] as const;
