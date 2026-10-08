/**
 * SDK client unit tests (mock fetch; no live server).
 * Covers Gmail-first host surface: list / get / sync + Connect helpers.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  InboxLink,
  InboxLinkApiError,
  INBOXLINK_PRODUCTION_URL,
  connectUrlForToken,
  parseConnectRedirect,
} from "./index.js";

describe("InboxLink SDK", () => {
  it("defaults baseUrl to Production and omits Bearer without apiSecret", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          linkToken: "lt_1",
          connectUrl: `${INBOXLINK_PRODUCTION_URL}/v1/connect/lt_1`,
          sessionId: "sess_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const il = new InboxLink({ fetch: fetchMock });
    assert.equal(il.baseUrl, INBOXLINK_PRODUCTION_URL);

    const session = await il.createConnectSession({
      externalUserId: "user-1",
      redirectUri: "http://127.0.0.1:9999/done",
    });

    assert.equal(session.linkToken, "lt_1");
    assert.match(calls[0]!.url, new RegExp(`^${INBOXLINK_PRODUCTION_URL}/v1/link/sessions$`));
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get("authorization"), null);
  });

  it("creates a link session with bearer auth when apiSecret is set", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          linkToken: "lt_1",
          connectUrl: "http://localhost:8787/v1/connect/lt_1",
          sessionId: "sess_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const session = await il.link.createSession({
      externalUserId: "user-1",
      redirectUri: "http://127.0.0.1:9999/done",
    });

    assert.equal(session.linkToken, "lt_1");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/v1\/link\/sessions$/);
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");
  });

  it("completeConnect exchanges publicToken and redirectUrl", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ grantId: "grant_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      fetch: fetchMock,
    });

    const a = await il.completeConnect({ publicToken: "pt_1" });
    assert.equal(a.grantId, "grant_1");
    assert.match(calls[0]!.url, /\/v1\/grants\/exchange$/);
    assert.equal(JSON.parse(String(calls[0]!.init?.body)).publicToken, "pt_1");

    const b = await il.completeConnect({
      redirectUrl: "http://127.0.0.1:9999/done?public_token=pt_2&link_token=lt_x",
    });
    assert.equal(b.grantId, "grant_1");
    assert.equal(JSON.parse(String(calls[1]!.init?.body)).publicToken, "pt_2");
  });

  it("parseConnectRedirect and connectUrlForToken helpers", () => {
    const parsed = parseConnectRedirect(
      "http://127.0.0.1:9999/done?public_token=pt_abc&link_token=lt_1",
    );
    assert.equal(parsed.publicToken, "pt_abc");
    assert.equal(parsed.linkToken, "lt_1");

    assert.equal(
      connectUrlForToken("lt_1"),
      `${INBOXLINK_PRODUCTION_URL}/v1/connect/lt_1`,
    );
    assert.equal(
      connectUrlForToken("lt_1", "http://localhost:8787/"),
      "http://localhost:8787/v1/connect/lt_1",
    );

    assert.throws(() => parseConnectRedirect("http://127.0.0.1:9999/done"), /missing public_token/);
  });

  it("lists messages with limit and cursor query params", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ messages: [], nextCursor: "next" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787/",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const page = await il.messages.list("grant_1", { limit: 10, cursor: "abc" });
    assert.deepEqual(page.messages, []);
    assert.equal(page.nextCursor, "next");
    assert.match(calls[0]!, /\/v1\/grants\/grant_1\/messages\?limit=10&cursor=abc$/);
  });

  it("lists messages with source=live and Gmail filter query params", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ messages: [], source: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      fetch: fetchMock,
    });
    await il.messages.list("grant_1", {
      source: "live",
      limit: 5,
      q: "is:unread",
      from: "ada@example.com",
      label: ["INBOX", "UNREAD"],
      includeSpamTrash: true,
    });
    const url = new URL(calls[0]!);
    assert.equal(url.searchParams.get("source"), "live");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("q"), "is:unread");
    assert.equal(url.searchParams.get("from"), "ada@example.com");
    assert.deepEqual(url.searchParams.getAll("label"), ["INBOX", "UNREAD"]);
    assert.equal(url.searchParams.get("includeSpamTrash"), "true");
  });

  it("gets a message by id with attachment metadata wrapper", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          message: {
            id: "msg_1",
            grantId: "grant_1",
            providerMessageId: "1",
            subject: "Hi",
            snippet: "",
            from: [],
            to: [],
            sentAt: "2026-01-01T00:00:00.000Z",
            receivedAt: "2026-01-01T00:00:00.000Z",
            folderIds: ["INBOX"],
            hasAttachments: true,
            attachments: [
              { id: "att_1", filename: "a.pdf", mimeType: "application/pdf", size: 12 },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const { message } = await il.messages.get("grant_1", "msg_1");
    assert.equal(message.id, "msg_1");
    assert.equal(message.attachments?.[0]?.filename, "a.pdf");
    assert.equal(message.attachments?.[0]?.mimeType, "application/pdf");
    assert.match(calls[0]!, /\/v1\/grants\/grant_1\/messages\/msg_1$/);
  });

  it("runs Gmail history sync via grants.sync", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          jobId: "sjob_1",
          grantId: "grant_1",
          status: "queued",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const result = await il.grants.sync("grant_1");
    assert.equal(result.status, "queued");
    assert.equal(result.jobId, "sjob_1");
    assert.match(calls[0]!.url, /\/v1\/grants\/grant_1\/sync$/);
  });

  it("polls sync job status via grants.getSyncJob", async () => {
    const fetchMock: typeof fetch = async (input) => {
      assert.match(String(input), /\/v1\/grants\/grant_1\/sync\/jobs\/sjob_1$/);
      return new Response(
        JSON.stringify({
          jobId: "sjob_1",
          grantId: "grant_1",
          status: "completed",
          result: { mode: "bootstrap", historyId: "1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const job = await il.grants.getSyncJob("grant_1", "sjob_1");
    assert.equal(job.status, "completed");
  });

  it("throws InboxLinkApiError with parsed detail on non-2xx", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "not_found", detail: "grant missing" }), {
        status: 404,
      });

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });

    await assert.rejects(
      () => il.messages.get("grant_1", "missing"),
      (err: unknown) => {
        assert.ok(err instanceof InboxLinkApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, "not_found");
        assert.equal(err.detail, "grant missing");
        assert.match(err.message, /grant missing/);
        return true;
      },
    );
  });

  it("verifies webhook HMAC signatures", () => {
    const il = new InboxLink({ baseUrl: "http://localhost:8787", apiSecret: "x" });
    const payload = JSON.stringify({ type: "grant.created" });
    const hex = createHmac("sha256", "whsec").update(payload).digest("hex");
    assert.equal(il.webhooks.verify({ payload, signatureHeader: `sha256=${hex}`, secret: "whsec" }), true);
    assert.equal(il.webhooks.verify({ payload, signatureHeader: `sha256=${hex}`, secret: "wrong" }), false);
  });

  it("verifySigned checks the HMAC over timestamp.body and rejects stale or future requests", () => {
    const il = new InboxLink({ baseUrl: "http://localhost:8787", apiSecret: "x" });
    const payload = JSON.stringify({ type: "message.created" });
    const nowMs = 1_800_000_000_000;
    const ts = String(nowMs / 1000);
    const sig = `sha256=${createHmac("sha256", "whsec").update(`${ts}.${payload}`).digest("hex")}`;
    const base = { payload, timestampHeader: ts, signatureHeader: sig, secret: "whsec", now: nowMs };
    assert.equal(il.webhooks.verifySigned(base), true);
    assert.equal(il.webhooks.verifySigned({ ...base, secret: "wrong" }), false);
    assert.equal(il.webhooks.verifySigned({ ...base, payload: payload + " " }), false);
    assert.equal(il.webhooks.verifySigned({ ...base, now: nowMs + 301_000 }), false);
    assert.equal(il.webhooks.verifySigned({ ...base, now: nowMs - 301_000 }), false);
    assert.equal(il.webhooks.verifySigned({ ...base, now: nowMs + 301_000, toleranceSec: 600 }), true);
    assert.equal(il.webhooks.verifySigned({ ...base, timestampHeader: "abc" }), false);
  });

  it("manages webhook endpoints over /v1/webhooks", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body as string | undefined });
      const status = init?.method === "DELETE" ? 204 : init?.method === "POST" ? 201 : 200;
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify({ id: "whe_1", webhooks: [], secret: "whsec_x" }), {
            status,
            headers: { "content-type": "application/json" },
          });
    };
    const il = new InboxLink({ baseUrl: "http://localhost:8787", apiSecret: "x", fetch: fetchMock });
    const created = await il.webhookEndpoints.create({
      url: "https://hooks.example.com/a",
      events: ["message.created"],
    });
    assert.equal(created.secret, "whsec_x");
    await il.webhookEndpoints.list();
    await il.webhookEndpoints.delete("whe_1");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "POST http://localhost:8787/v1/webhooks",
        "GET http://localhost:8787/v1/webhooks",
        "DELETE http://localhost:8787/v1/webhooks/whe_1",
      ],
    );
    assert.deepEqual(JSON.parse(calls[0]!.body!), {
      url: "https://hooks.example.com/a",
      events: ["message.created"],
    });
  });
});
