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

export type InboxLinkClientOptions = {
  /** API origin, e.g. `https://inboxlink.example.com` or `http://localhost:8787`. */
  baseUrl: string;
  /** Bearer secret (`INBOXLINK_API_SECRET`). Required in `multi` mode; still sent in `single`. */
  apiSecret: string;
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

/** HTTP error from the InboxLink API (non-2xx). */
export class InboxLinkApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(input: { method: string; path: string; status: number; body: string }) {
    super(`InboxLink ${input.method} ${input.path} → ${input.status}: ${input.body.slice(0, 300)}`);
    this.name = "InboxLinkApiError";
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
    this.body = input.body;
  }
}

export class InboxLink {
  readonly link: LinkApi;
  readonly grants: GrantsApi;
  readonly messages: MessagesApi;
  readonly webhooks: WebhooksApi;

  constructor(options: InboxLinkClientOptions) {
    const http = new HttpClient(options);
    this.link = new LinkApi(http);
    this.grants = new GrantsApi(http);
    this.messages = new MessagesApi(http);
    this.webhooks = new WebhooksApi();
  }
}

class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InboxLinkClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = new URL(path, ensureTrailingSlash(this.options.baseUrl));
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiSecret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new InboxLinkApiError({ method, path, status: res.status, body: text });
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

export { InboxLink as default };
