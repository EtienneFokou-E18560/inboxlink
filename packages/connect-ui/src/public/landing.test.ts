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
    assert.match(html, /href="\/docs"/);
    assert.match(html, /data-testid="landing-wiki"/);
    assert.match(html, /inboxlink\/wiki/);
    assert.match(html, /data-testid="landing-npm"/);
    assert.match(html, /@inboxlink\/core\/v\/0\.1\.1/);
    assert.match(html, /npm core@0\.1\.1/);
    assert.match(html, /npm i @inboxlink\/core@0\.1\.1/);
    assert.match(html, /0\.1\.0 today/);
    assert.doesNotMatch(html, /npm i @inboxlink\/sdk@0\.1\.1/);
    assert.doesNotMatch(html, /@inboxlink\/sdk\/v\/0\.1\.1/);
    assert.match(html, /session → connect → grantId → messages/);
    assert.match(html, /href="\/health"/);
    assert.match(html, /Fraunces/);
    assert.match(html, /--accent:/);
    assert.doesNotMatch(html, /grant console/i);
  });

  it("escapes custom link URLs", () => {
    const html = renderLandingPage({
      githubUrl: 'https://example.com/"onclick=alert(1)',
      docsHubUrl: "https://docs.example/<script>",
      wikiUrl: 'https://wiki.example/"x',
      npmCoreUrl: "https://npm.example/<bad>",
      healthPath: '/health?"x',
    });
    assert.doesNotMatch(html, /<script>/i);
    assert.match(
      html,
      /href="https:\/\/example\.com\/&quot;onclick=alert\(1\)"/,
    );
    assert.match(html, /href="https:\/\/docs\.example\/&lt;script&gt;"/);
    assert.match(html, /href="https:\/\/wiki\.example\/&quot;x"/);
    assert.match(html, /href="https:\/\/npm\.example\/&lt;bad&gt;"/);
    assert.match(html, /href="\/health\?&quot;x"/);
  });
});
