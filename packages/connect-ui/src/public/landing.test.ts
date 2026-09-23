import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderLandingPage } from "./landing.js";

describe("renderLandingPage", () => {
  it("is brand-first with promise and default CTAs", () => {
    const html = renderLandingPage();
    assert.match(html, /<title>InboxLink<\/title>/);
    assert.match(html, /class="brand-hero"/);
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /Connect mailboxes without holding tokens/);
    assert.match(html, /data-testid="landing-github"/);
    assert.match(
      html,
      /href="https:\/\/github\.com\/EtienneFokou-E18560\/inboxlink"/,
    );
    assert.match(html, /data-testid="landing-docs"/);
    assert.match(html, /host-integration\.md/);
    assert.match(html, /data-testid="landing-health"/);
    assert.match(html, /href="\/health"/);
    assert.match(html, /session → connect → grantId → messages/);
    assert.match(html, /Fraunces/);
    assert.match(html, /--accent:/);
    assert.doesNotMatch(html, /grant console/i);
  });

  it("escapes custom link URLs", () => {
    const html = renderLandingPage({
      githubUrl: 'https://example.com/"onclick=alert(1)',
      hostDocsUrl: "https://docs.example/<script>",
      healthPath: '/health?"x',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(
      html,
      /href="https:\/\/example\.com\/&quot;onclick=alert\(1\)"/,
    );
    assert.match(html, /href="https:\/\/docs\.example\/&lt;script&gt;"/);
    assert.match(html, /href="\/health\?&quot;x"/);
  });
});
