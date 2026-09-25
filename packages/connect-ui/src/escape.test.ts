import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, unescapeHtml } from "./escape.js";

describe("escapeHtml / unescapeHtml", () => {
  it("round-trips special characters", () => {
    const raw = `a&b<"'>`;
    assert.equal(unescapeHtml(escapeHtml(raw)), raw);
  });

  it("does not double-unescape &amp; before other entities", () => {
    // If &amp; were replaced first, &amp;quot; would become " — wrong.
    assert.equal(unescapeHtml("&amp;quot;"), "&quot;");
    assert.equal(unescapeHtml("x&amp;y"), "x&y");
    assert.equal(unescapeHtml("&quot;hi&quot;"), '"hi"');
  });
});
