/**
 * SDK client unit tests (mock fetch; no live server).
 * Covers Gmail-first host surface: list / get / sync.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { InboxLink, InboxLinkApiError } from "./index.js";

describe("InboxLink SDK", () => {
  it("creates a link session with bearer auth", async () => {
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
      redirectUri: "http://localhost:9999/done",
    });

    assert.equal(session.linkToken, "lt_1");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/v1\/link\/sessions$/);
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");
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
          grantId: "grant_1",
          status: "ok",
          mode: "incremental",
          historyId: "99",
          upserted: 2,
          deleted: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const il = new InboxLink({
      baseUrl: "http://localhost:8787",
      apiSecret: "secret",
      fetch: fetchMock,
    });
    const result = await il.grants.sync("grant_1");
    assert.equal(result.mode, "incremental");
    assert.equal(result.historyId, "99");
    assert.match(calls[0]!.url, /\/v1\/grants\/grant_1\/sync$/);
  });

  it("throws InboxLinkApiError on non-2xx", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 });

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
});
