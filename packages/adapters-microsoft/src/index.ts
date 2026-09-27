import type { MailboxAdapter, Message } from "@inboxlink/core";
import {
  normalizeGraphMessage,
  type GraphMessageResource,
} from "./normalize.js";

export type MicrosoftAdapterConfig = {
  clientId: string;
  clientSecret: string;
  /** Default redirect used when callers omit redirectUri. */
  redirectUri: string;
  /**
   * Authority tenant segment for login.microsoftonline.com/{tenant}.
   * Default `common` accepts work/school and personal Microsoft accounts.
   * Use `organizations`, `consumers`, or a directory tenant id to narrow.
   */
  tenant?: string;
  authBaseUrl?: string;
  tokenUrl?: string;
  /** Graph REST base, default `https://graph.microsoft.com/v1.0`. Tests point this at a local server. */
  graphBaseUrl?: string;
};

export class MicrosoftApiError extends Error {
  constructor(readonly status: number) {
    super(`Microsoft Graph API request failed: ${status}`);
    this.name = "MicrosoftApiError";
  }
}

export { normalizeGraphMessage, type GraphMessageResource };

/**
 * Microsoft Graph mail adapter.
 * OAuth against the Microsoft identity platform; list via Graph `/me/messages`.
 * No production secrets are bundled.
 *
 * Default tenant is `common` (personal + work/school). See package README / repo docs.
 */
export class MicrosoftAdapter implements MailboxAdapter {
  readonly provider = "microsoft" as const;

  constructor(private readonly config: MicrosoftAdapterConfig) {}

  private tenant(): string {
    return this.config.tenant?.trim() || "common";
  }

  private authUrl(): string {
    return (
      this.config.authBaseUrl ??
      `https://login.microsoftonline.com/${this.tenant()}/oauth2/v2.0/authorize`
    );
  }

  private tokenEndpoint(): string {
    return (
      this.config.tokenUrl ??
      `https://login.microsoftonline.com/${this.tenant()}/oauth2/v2.0/token`
    );
  }

  private graphBase(): string {
    return (this.config.graphBaseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
  }

  buildAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
  }): string {
    const url = new URL(this.authUrl());
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri || this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", input.scopes.join(" "));
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

    if (isPlaceholder(this.config.clientId) || isPlaceholder(this.config.clientSecret)) {
      return {
        accessToken: "stub-ms-access-token",
        refreshToken: "stub-ms-refresh-token",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        email: "stub-user@outlook.com",
        scopes: [...DEFAULT_MICROSOFT_SCOPES],
      };
    }

    const res = await fetch(this.tokenEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Microsoft token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      id_token?: string;
    };
    const email =
      emailFromIdToken(json.id_token) ?? (await this.fetchProfileEmail(json.access_token));
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

  private async fetchProfileEmail(accessToken: string): Promise<string | undefined> {
    try {
      const me = await graphJson<{ mail?: string; userPrincipalName?: string }>(
        new URL(`${this.graphBase()}/me`),
        accessToken,
      );
      return me.mail?.trim() || me.userPrincipalName?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt?: string;
  }> {
    if (isPlaceholder(this.config.clientId) || isPlaceholder(this.config.clientSecret)) {
      return {
        accessToken: "stub-ms-access-token-refreshed",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch(this.tokenEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Microsoft refresh failed: ${res.status}`);
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
   * List mailbox messages via Graph `/me/messages` and normalize each resource.
   * Callers pass a short-lived access token. This method does not see the refresh token.
   */
  async listMessages(input: {
    accessToken: string;
    grantId: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const url = new URL(`${this.graphBase()}/me/messages`);
    url.searchParams.set("$top", String(input.maxResults ?? 20));
    url.searchParams.set(
      "$select",
      [
        "id",
        "conversationId",
        "subject",
        "bodyPreview",
        "from",
        "toRecipients",
        "ccRecipients",
        "sentDateTime",
        "receivedDateTime",
        "parentFolderId",
        "hasAttachments",
        "body",
        "categories",
      ].join(","),
    );
    url.searchParams.set("$orderby", "receivedDateTime desc");
    if (input.pageToken) url.searchParams.set("$skiptoken", input.pageToken);

    const listed = await graphJson<{
      value?: GraphMessageResource[];
      "@odata.nextLink"?: string;
    }>(url, input.accessToken);

    const messages: Message[] = [];
    for (const raw of listed.value ?? []) {
      const message = normalizeGraphMessage(raw, input.grantId);
      if (message) messages.push(message);
    }
    return {
      messages,
      nextCursor: skiptokenFromNextLink(listed["@odata.nextLink"]),
    };
  }
}

async function graphJson<T>(url: URL, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!res.ok) throw new MicrosoftApiError(res.status);
  return (await res.json()) as T;
}

function skiptokenFromNextLink(nextLink: string | undefined): string | undefined {
  if (!nextLink) return undefined;
  try {
    const url = new URL(nextLink);
    return (
      url.searchParams.get("$skiptoken") ??
      url.searchParams.get("skiptoken") ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
    };
    return json.email ?? json.preferred_username;
  } catch {
    return undefined;
  }
}

function isPlaceholder(value: string): boolean {
  return (
    !value ||
    value.includes("your-microsoft") ||
    value.includes("change-me") ||
    value.startsWith("replace-")
  );
}

/** Delegated Mail.Read + offline_access; works for personal and work/school with tenant=common. */
export const DEFAULT_MICROSOFT_SCOPES = [
  "openid",
  "offline_access",
  "email",
  "https://graph.microsoft.com/Mail.Read",
] as const;
