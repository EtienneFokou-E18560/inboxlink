import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGmailMessage } from "./normalize.js";
import { charsetOf, decodeHtmlEntities, decodeWithCharset } from "./text.js";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

function resource(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    snippet: "Hello",
    internalDate: "1710000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Ada <ada@example.com>" },
        { name: "Subject", value: "Hi" },
      ],
      body: { data: b64("Hello") },
    },
    ...over,
  };
}

describe("snippet", () => {
  it("is decoded from Gmail's HTML-escaped form", () => {
    const m = normalizeGmailMessage(resource({ snippet: "We&#39;re grateful &amp; ready &quot;now&quot; &#x27;ok&#x27; &lt;3" }), "g1")!;
    assert.equal(m.snippet, `We're grateful & ready "now" 'ok' <3`);
  });

  it("is left alone when it has no entities, and an unknown entity is kept as written", () => {
    assert.equal(decodeHtmlEntities("Plain text, 5 < 6"), "Plain text, 5 < 6");
    assert.equal(decodeHtmlEntities("&unknown; &#99999999999;"), "&unknown; &#99999999999;");
  });
});

describe("body charset", () => {
  it("decodes a latin-1 body by its declared charset instead of mangling it as UTF-8", () => {
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in ISO-8859-1
    const m = normalizeGmailMessage(
      resource({
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }, { name: "Subject", value: "x" }],
          body: { data: b64(latin1) },
        },
      }),
      "g1",
    )!;
    assert.equal(m.body?.text, "Café");
  });

  it("decodes each part by its own charset", () => {
    const m = normalizeGmailMessage(
      resource({
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "x" }],
          parts: [
            { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=windows-1252" }], body: { data: b64(Uint8Array.from([0x93, 0x68, 0x69, 0x94])) } },
            { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: b64("<p>héllo</p>") } },
          ],
        },
      }),
      "g1",
    )!;
    assert.equal(m.body?.text, "“hi”");
    assert.equal(m.body?.html, "<p>héllo</p>");
  });

  it("treats a missing or unknown charset as UTF-8", () => {
    assert.equal(decodeWithCharset(new TextEncoder().encode("héllo"), undefined), "héllo");
    assert.equal(decodeWithCharset(new TextEncoder().encode("héllo"), "x-no-such-charset"), "héllo");
    assert.equal(charsetOf("text/plain"), undefined);
    assert.equal(charsetOf("text/plain; charset=UTF-8"), "utf-8");
  });

  it("keeps ordinary UTF-8 mail exactly as before", () => {
    const m = normalizeGmailMessage(resource({ payload: { mimeType: "text/plain", headers: [], body: { data: b64("Plain ASCII and ünïcode ✓") } } }), "g1")!;
    assert.equal(m.body?.text, "Plain ASCII and ünïcode ✓");
  });
});
