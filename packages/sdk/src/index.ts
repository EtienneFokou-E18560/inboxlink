/**
 * @inboxlink/sdk — host-app client for the InboxLink HTTP API.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateLinkSessionInput, Grant, Message } from "@inboxlink/core";

export type {
  CreateLinkSessionInput,
  EmailAddress,
  Grant,
  GrantStatus,
  Message,
  MessageAttachment,
  Provider,
} from "@inboxlink/core";

/** Documented Production origin. Used when `baseUrl` is omitted. */
export const INBOXLINK_PRODUCTION_URL = "https://inboxlink-two.vercel.app";

export type InboxLinkClientOptions = {
  /**
   * API origin. Defaults to {@link INBOXLINK_PRODUCTION_URL}.
   * Override for local (`http://localhost:8787`) or self-hosted deployments.
   */
  baseUrl?: string;
  /**
   * Bearer secret (`INBOXLINK_API_SECRET`).
   * Required only when the server runs `INBOXLINK_MODE=multi`.
   * Omit for Production / `single` mode — the Authorization header is not sent.
   */
  apiSecret?: string;
  fetch?: typeof fetch;
};

export type ListMessagesOptions = {
  /** Page size. Server currently accepts 1–25 (default 20). */
  limit?: number;
  /** Opaque pagination cursor from a previous `nextCursor`. */
  cursor?: string;
};

export type IterateMessagesOptions = {
  /** Skip messages with `receivedAt` earlier than this ISO timestamp. */
  since?: string;
  limit?: number;
};

export type LinkSessionResult = {
  linkToken: string;
  connectUrl: string;
  sessionId: string;
  expiresAt?: string;
};

export type ListMessagesResult = {
  messages: Message[];
  nextCursor?: string;
};

export type SyncResult = {
  grantId: string;
  status: string;
  mode: string;
  historyId?: string;
  upserted?: number;
  deleted?: number;
};

export type SyncOptions = {
  mode?: "full" | "bootstrap" | "incremental";
};

export type ConnectRedirectParams = {
  /** One-time token for `grants.exchange` / `completeConnect`. */
  publicToken: string;
  /** Original link token (optional correlation). */
  linkToken?: string;
};

/** HTTP error from the InboxLink API (non-2xx). */
export class InboxLinkApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  /** Parsed `error` field when the body is JSON. */
  readonly code?: string;
  /** Parsed `detail` / guidance when the body is JSON. */
  readonly detail?: string;

  constructor(input: {
    method: string;
    path: string;
    status: number;
    body: string;
    code?: string;
    detail?: string;
  }) {
    const hint = input.detail ?? input.code;
    const suffix = hint ? ` — ${hint}` : `: ${input.body.slice(0, 300)}`;
    super(`InboxLink ${input.method} ${input.path} → ${input.status}${suffix}`);
    this.name = "InboxLinkApiError";
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
    this.body = input.body;
    this.code = input.code;
    this.detail = input.detail;
  }
}

/**
 * Parse the host redirect URL (or query string) after Connect completes.
 * Expects `public_token` (required) and optional `link_token`.
 */
export function parseConnectRedirect(
  input: string | URL | { searchParams: URLSearchParams },
): ConnectRedirectParams {
  let params: URLSearchParams;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error(
        "parseConnectRedirect: empty input. Pass the full redirect URL or a query string containing public_token.",
      );
    }
    try {
      params = trimmed.includes("://")
        ? new URL(trimmed).searchParams
        : new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
    } catch {
      throw new Error(
        "parseConnectRedirect: could not parse URL. Pass the full redirect URL your host received after Connect.",
      );
    }
  } else if (input instanceof URL) {
    params = input.searchParams;
  } else {
    params = input.searchParams;
  }

  const publicToken = params.get("public_token")?.trim() || undefined;
  if (!publicToken) {
    throw new Error(
      "parseConnectRedirect: missing public_token. Connect may have failed (InboxLink shows an error page instead of redirecting), or the user landed on the wrong route.",
    );
  }
  const linkToken = params.get("link_token")?.trim() || undefined;
  return { publicToken, linkToken };
}

/** Build the hosted Connect page URL for a link token (same shape as session.connectUrl). */
export function connectUrlForToken(
  linkToken: string,
  baseUrl: string = INBOXLINK_PRODUCTION_URL,
): string {
  const token = linkToken.trim();
  if (!token) {
    throw new Error("connectUrlForToken: linkToken is required");
  }
  const origin = ensureNoTrailingSlash(baseUrl || INBOXLINK_PRODUCTION_URL);
  return `${origin}/v1/connect/${encodeURIComponent(token)}`;
}

export class InboxLink {
  readonly link: LinkApi;
  readonly grants: GrantsApi;
  readonly messages: MessagesApi;
  readonly webhooks: WebhooksApi;
  /** Resolved API origin (after defaults). */
  readonly baseUrl: string;

  constructor(options: InboxLinkClientOptions = {}) {
    const baseUrl = ensureNoTrailingSlash(
      options.baseUrl?.trim() || INBOXLINK_PRODUCTION_URL,
    );
    if (!baseUrl) {
      throw new Error(
        "InboxLink: baseUrl is empty. Pass baseUrl or rely on the Production default.",
      );
    }
    this.baseUrl = baseUrl;
    const apiSecret = options.apiSecret?.trim() || undefined;
    const http = new HttpClient({ baseUrl, apiSecret, fetch: options.fetch });
    this.link = new LinkApi(http);
    this.grants = new GrantsApi(http);
    this.messages = new MessagesApi(http);
    this.webhooks = new WebhooksApi();
  }

  /**
   * High-level Connect entry: create a session and return `connectUrl` for the browser.
   * Same as `link.createSession` — prefer this name in host apps.
   */
  createConnectSession(input: CreateLinkSessionInput): Promise<LinkSessionResult> {
    return this.link.createSession(input);
  }

  /**
   * Finish Connect: exchange a one-time `public_token` (or a full redirect URL) for `grantId`.
   * Call from your host redirect/BFF handler — never from a browser that holds an API secret.
   */
  completeConnect(
    input: { publicToken: string } | { redirectUrl: string },
  ): Promise<{ grantId: string }> {
    const publicToken =
      "publicToken" in input && input.publicToken
        ? input.publicToken
        : parseConnectRedirect((input as { redirectUrl: string }).redirectUrl).publicToken;
    return this.grants.exchange({ publicToken });
  }
}

class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiSecret?: string;

  constructor(options: {
    baseUrl: string;
    apiSecret?: string;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl;
    this.apiSecret = options.apiSecret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(path, ensureTrailingSlash(this.baseUrl));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.apiSecret) {
      headers.authorization = `Bearer ${this.apiSecret}`;
    }
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      const parsed = tryParseErrorBody(text);
      throw new InboxLinkApiError({
        method,
        path,
        status: res.status,
        body: text,
        code: parsed?.code,
        detail: parsed?.detail,
      });
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }
}

class LinkApi {
  constructor(private readonly http: HttpClient) {}

  /** Create a Connect session for an end user. */
  createSession(input: CreateLinkSessionInput): Promise<LinkSessionResult> {
    if (!input.externalUserId?.trim()) {
      throw new Error("link.createSession: externalUserId is required");
    }
    if (!input.redirectUri?.trim()) {
      throw new Error(
        "link.createSession: redirectUri is required (your host callback URL that receives public_token — not the Google OAuth redirect).",
      );
    }
    return this.http.request("POST", "v1/link/sessions", {
      externalUserId: input.externalUserId,
      redirectUri: input.redirectUri,
      products: input.products ?? ["messages"],
    });
  }
}

class GrantsApi {
  constructor(private readonly http: HttpClient) {}

  /** Exchange a one-time public token from Connect for a durable grant id. */
  exchange(input: { publicToken: string }): Promise<{ grantId: string }> {
    if (!input.publicToken?.trim()) {
      throw new Error(
        "grants.exchange: publicToken is required. Read it from the Connect redirect query (?public_token=…) via parseConnectRedirect or completeConnect.",
      );
    }
    return this.http.request("POST", "v1/grants/exchange", input);
  }

  list(externalUserId: string): Promise<{ grants: Grant[] }> {
    return this.http.request(
      "GET",
      `v1/grants?externalUserId=${encodeURIComponent(externalUserId)}`,
    );
  }

  revoke(grantId: string): Promise<void> {
    return this.http.request("DELETE", `v1/grants/${encodeURIComponent(grantId)}`);
  }

  /** Run history sync (bootstrap / incremental / full). Maps to `POST /v1/grants/:grantId/sync`. */
  sync(grantId: string, opts?: SyncOptions): Promise<SyncResult> {
    const body =
      opts?.mode && opts.mode !== "incremental" ? { mode: opts.mode } : undefined;
    return this.http.request("POST", `v1/grants/${encodeURIComponent(grantId)}/sync`, body);
  }
}

class MessagesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List normalized messages for a grant.
   * Maps to `GET /v1/grants/:grantId/messages`.
   */
  list(grantId: string, opts?: ListMessagesOptions): Promise<ListMessagesResult> {
    const q = new URLSearchParams();
    if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts?.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.http.request(
      "GET",
      `v1/grants/${encodeURIComponent(grantId)}/messages${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Fetch a single message by id (InboxLink `msg_…` or provider Gmail id).
   * Maps to `GET /v1/grants/:grantId/messages/:messageId`.
   * Response includes optional attachment metadata (id, filename, mimeType, size) — not bytes.
   */
  get(grantId: string, messageId: string): Promise<{ message: Message }> {
    return this.http.request(
      "GET",
      `v1/grants/${encodeURIComponent(grantId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  /** Walk list pages until exhausted (or filtered by `since`). */
  async *iterate(
    grantId: string,
    opts?: IterateMessagesOptions,
  ): AsyncGenerator<Message> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(grantId, { limit: opts?.limit ?? 20, cursor });
      for (const msg of page.messages) {
        if (opts?.since && msg.receivedAt < opts.since) continue;
        yield msg;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
}

class WebhooksApi {
  /** Verify `sha256=<hex>` HMAC signatures (constant-time). */
  verify(input: {
    payload: string;
    signatureHeader: string;
    secret: string;
  }): boolean {
    const expected = createHmac("sha256", input.secret).update(input.payload).digest("hex");
    const provided = input.signatureHeader.replace(/^sha256=/i, "").trim();
    try {
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(provided, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

function ensureNoTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

function tryParseErrorBody(text: string): { code?: string; detail?: string } | undefined {
  try {
    const json = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
    const code = typeof json.error === "string" ? json.error : undefined;
    const detail =
      typeof json.detail === "string"
        ? json.detail
        : typeof json.message === "string"
          ? json.message
          : undefined;
    if (code || detail) return { code, detail };
  } catch {
    // non-JSON body
  }
  return undefined;
}

export { InboxLink as default };
