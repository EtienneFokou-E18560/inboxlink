import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderLandingPage } from "./landing.js";

describe("renderLandingPage", () => {
  it("is brand-first and sends people to the website, GitHub and npm", () => {
    const html = renderLandingPage();
    assert.match(html, /<title>InboxLink<\/title>/);
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /Connect mailboxes without holding tokens/);
    assert.match(html, /data-testid="landing-website" href="https:\/\/inboxlink\.cieltd\.org"/);
    assert.match(html, /href="https:\/\/inboxlink\.cieltd\.org\/for-mailbox-owners\/"/);
    assert.match(html, /data-testid="landing-github" href="https:\/\/github\.com\/EtienneFokou-E18560\/inboxlink"/);
    assert.match(html, /data-testid="landing-npm" href="https:\/\/www\.npmjs\.com\/package\/@inboxlink\/sdk"/);
    assert.match(html, /npm i @inboxlink\/sdk/);
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /href="\/terms"/);
    assert.match(html, /href="\/health"/);
    // No pinned versions or retired destinations that go stale.
    assert.doesNotMatch(html, /0\.1\.1|\/wiki|href="\/docs"/);
  });

  it("escapes custom link URLs", () => {
    const html = renderLandingPage({
      githubUrl: 'https://example.com/"onclick=alert(1)',
      websiteUrl: "https://site.example/<script>",
      npmUrl: "https://npm.example/<bad>",
      healthPath: '/health?"x',
    });
    assert.doesNotMatch(html, /<script>/i);
    assert.match(html, /href="https:\/\/example\.com\/&quot;onclick=alert\(1\)"/);
    assert.match(html, /href="https:\/\/site\.example\/&lt;script&gt;"/);
    assert.match(html, /href="https:\/\/npm\.example\/&lt;bad&gt;"/);
    assert.match(html, /href="\/health\?&quot;x"/);
  });
});
