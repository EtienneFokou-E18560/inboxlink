import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderPrivacyPage, renderTermsPage } from "./legal.js";

describe("legal pages", () => {
  it("privacy states what is stored, deletion, and the Google Limited Use commitment", () => {
    const html = renderPrivacyPage();
    assert.match(html, /<h1>Privacy<\/h1>/);
    assert.match(html, /AES-256-GCM/);
    assert.match(html, /Limited Use/);
    assert.match(html, /api-services-user-data-policy/);
    assert.match(html, /revoking the grant/);
    assert.match(html, /href="\/terms"/);
  });

  it("terms render and escape a caller-supplied contact URL", () => {
    const html = renderTermsPage({ contactUrl: 'mailto:a@b.c?x="y"<z>' });
    assert.match(html, /<h1>Terms<\/h1>/);
    assert.doesNotMatch(html, /"y"<z>/);
    assert.match(html, /&quot;y&quot;&lt;z&gt;/);
  });
});
