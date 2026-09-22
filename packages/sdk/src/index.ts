import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateLinkSessionInput, Grant, Message } from "@inboxlink/core";

export type InboxLinkClientOptions = {
  baseUrl: string;
  apiSecret: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

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

  async request<T>(method: string, path: string, body?: Json): Promise<T> {
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
      throw new Error(`InboxLink ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }
}

class LinkApi {
  constructor(private readonly http: HttpClient) {}

  createSession(input: CreateLinkSessionInput): Promise<{
    linkToken: string;
    connectUrl: string;
    sessionId: string;
  }> {
    return this.http.request("POST", "v1/link/sessions", {
      externalUserId: input.externalUserId,
      redirectUri: input.redirectUri,
      products: input.products ?? ["messages"],
    });
  }
}

class GrantsApi {
  constructor(private readonly http: HttpClient) {}

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
}

class MessagesApi {
  constructor(private readonly http: HttpClient) {}

  list(
    grantId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ messages: Message[]; nextCursor?: string }> {
    const q = new URLSearchParams();
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return this.http.request(
      "GET",
      `v1/grants/${encodeURIComponent(grantId)}/messages${qs ? `?${qs}` : ""}`,
    );
  }

  async *iterate(
    grantId: string,
    opts?: { since?: string; limit?: number },
  ): AsyncGenerator<Message> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(grantId, { limit: opts?.limit ?? 50, cursor });
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
  verify(input: {
    payload: string;
    signatureHeader: string;
    secret: string;
  }): boolean {
    const expected = createHmac("sha256", input.secret)
      .update(input.payload)
      .digest("hex");
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
