/**
 * Message type: the optional bulk-mail `headers` and the Gmail label fields.
 * Type-checked by `pnpm typecheck` (tsconfig.test.json) and run by `pnpm test`.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InboxLink, type Message, type MessageHeaders } from "./index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(_: T): void => {};

// Compile-time contract: every field optional, raw strings, and `headers` optional on Message.
expectType<
  Equal<MessageHeaders, { listUnsubscribe?: string; precedence?: string; autoSubmitted?: string }>
>(true);
expectType<Equal<Message["headers"], MessageHeaders | undefined>>(true);
expectType<Equal<Message["labels"], string[] | undefined>>(true);
expectType<Equal<Message["folderIds"], string[]>>(true);

const base: Message = {
  id: "msg_1",
  grantId: "grant_1",
  providerMessageId: "1",
  subject: "Up to 35% off",
  snippet: "Plus, get $0 Delivery Fee",
  from: [{ name: "Shop", email: "deals@shop.example" }],
  to: [{ email: "me@example.com" }],
  sentAt: "2026-10-18T12:00:00.000Z",
  receivedAt: "2026-10-18T12:00:00.000Z",
  folderIds: ["INBOX", "CATEGORY_PROMOTIONS"],
  labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  hasAttachments: false,
};

describe("Message headers (SDK)", () => {
  it("passes live-list headers through untouched and leaves them absent when the server sends none", async () => {
    const withHeaders: Message = {
      ...base,
      headers: { listUnsubscribe: "<https://shop.example/u/1>", precedence: "bulk" },
    };
    const without: Message = { ...base, id: "msg_2", providerMessageId: "2" };
    const urls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ messages: [withHeaders, without], source: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const il = new InboxLink({ baseUrl: "http://127.0.0.1:9", fetch: fetchMock });
    const page = await il.messages.list("grant_1", { source: "live" });

    assert.ok(urls[0]?.includes("source=live"));
    assert.deepEqual(page.messages[0]?.headers, {
      listUnsubscribe: "<https://shop.example/u/1>",
      precedence: "bulk",
    });
    assert.equal(page.messages[1]?.headers, undefined);
    assert.deepEqual(page.messages[0]?.labels, ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
  });
});
