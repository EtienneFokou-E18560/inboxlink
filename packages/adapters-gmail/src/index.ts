import type { MailboxAdapter, Message } from "@inboxlink/core";
import {
  collectAttachments,
  normalizeGmailMessage,
  type GmailMessageResource,
} from "./normalize.js";

export type GmailAdapterConfig = {
  clientId: string;
  clientSecret: string;
  /** Default redirect used when callers omit redirectUri. */
  redirectUri: string;
  authBaseUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  /** Gmail REST base, default `https://gmail.googleapis.com/gmail/v1`. Tests point this at a local server. */
  gmailApiBaseUrl?: string;
};

export class GmailApiError extends Error {
  constructor(readonly status: number) {
    super(`Gmail API request failed: ${status}`);
    this.name = "GmailApiError";
  }
}

export { collectAttachments, normalizeGmailMessage, type GmailMessageResource };

const DEFAULT_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Gmail OAuth adapter (v0 stub).
 * Builds real authorization URLs and token exchange requests against Google,
 * and lists messages when a vaulted refresh token is exchanged for an access token.
 * No production secrets are bundled.
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
      id_token?: string;
    };
    const email =
      emailFromIdToken(json.id_token) ?? (await this.fetchEmail(json.access_token));
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt:
        typeof json.expires_in === "number"
          ? new Date(Date.now() + json.expires_in * 1000).toISOString()
          : undefined,
      email,
      scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
    };
  }

  private async fetchEmail(accessToken: string): Promise<string | undefined> {
    const res = await fetch(
      this.config.userinfoUrl ?? "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { email?: string };
    return json.email;
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

  /**
   * List mailbox messages and normalize each `format=full` resource.
   * Callers pass a short-lived access token. This method does not see the refresh token.
   */
  async listMessages(input: {
    accessToken: string;
    grantId: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const base = gmailBase(this.config.gmailApiBaseUrl);
    const listUrl = new URL(`${base}/users/me/messages`);
    listUrl.searchParams.set("maxResults", String(input.maxResults ?? 20));
    if (input.pageToken) listUrl.searchParams.set("pageToken", input.pageToken);
    const listed = await gmailJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
      listUrl,
      input.accessToken,
    );
    const messages: Message[] = [];
    for (const item of listed.messages ?? []) {
      const message = await this.fetchNormalizedMessage(base, input.accessToken, input.grantId, item.id);
      if (message) messages.push(message);
    }
    return { messages, nextCursor: listed.nextPageToken };
  }

  /**
   * Fetch one message by Gmail id (`format=full`), including attachment metadata.
   * Does not download attachment bytes.
   */
  async getMessage(input: {
    accessToken: string;
    grantId: string;
    /** Gmail `users.messages` id (not the InboxLink `msg_` prefix). */
    messageId: string;
  }): Promise<Message | undefined> {
    const base = gmailBase(this.config.gmailApiBaseUrl);
    return this.fetchNormalizedMessage(base, input.accessToken, input.grantId, input.messageId);
  }

  private async fetchNormalizedMessage(
    base: string,
    accessToken: string,
    grantId: string,
    messageId: string,
  ): Promise<Message | undefined> {
    const getUrl = new URL(`${base}/users/me/messages/${encodeURIComponent(messageId)}`);
    getUrl.searchParams.set("format", "full");
    const raw = await gmailJson<GmailMessageResource>(getUrl, accessToken);
    return normalizeGmailMessage(raw, grantId);
  }
}

function gmailBase(configured: string | undefined): string {
  return (configured ?? "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, "");
}

async function gmailJson<T>(url: URL, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GmailApiError(res.status);
  return (await res.json()) as T;
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
    };
    return json.email;
  } catch {
    return undefined;
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
