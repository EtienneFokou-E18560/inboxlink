import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DOCS_REPO_BASE,
  DEFAULT_WIKI_BASE,
  LIVE_CORE_NPM_VERSION,
  LIVE_SDK_NPM_VERSION,
  SDK_MAIN_VERSION,
  docsHubCatalog,
  renderDocsHubPage,
} from "./docs-hub.js";

describe("renderDocsHubPage", () => {
  it("renders Connect brand, step strip IA, and accurate npm status", () => {
    const html = renderDocsHubPage();
    assert.match(html, /Inbox<span>Link<\/span>/);
    assert.match(html, /data-testid="docs-hub"/);
    assert.match(html, /data-testid="docs-step-strip"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /Host.*Connect.*Grant.*Messages/s);
    assert.match(html, /#host/);
    assert.match(html, /#connect/);
    assert.match(html, /#grant/);
    assert.match(html, /#messages/);
    assert.match(html, /docs\/host-integration\.md/);
    assert.match(html, /packages\/sdk\/README\.md/);
    assert.match(html, /examples\/host-integration/);
    assert.match(html, /@inboxlink\/core@0\.1\.1/);
    assert.match(html, /@inboxlink\/sdk@0\.1\.0/);
    assert.match(html, /npmjs\.com\/package\/@inboxlink\/core\/v\/0\.1\.1/);
    assert.match(html, /after #40 publish/);
    assert.match(html, /Production HTTP/);
    assert.match(html, /inboxlink\/wiki/);
    assert.match(html, /Messages-API/);
    assert.match(html, /filters/);
    assert.match(html, /Fraunces/);
    assert.match(html, /--accent:\s*#0f6e56/);
    assert.match(html, /class="shell docs-shell"/);
    assert.doesNotMatch(html, /npm i @inboxlink\/sdk@0\.1\.1/);
    assert.doesNotMatch(html, /@inboxlink\/sdk\/v\/0\.1\.1/);
    assert.doesNotMatch(html, /Stub Connect UI/);
  });

  it("escapes custom repo bases used in links", () => {
    const html = renderDocsHubPage({
      repoBlobBase: 'https://example.test/x?"y"',
      repoTreeBase: "https://example.test/tree",
    });
    assert.match(
      html,
      /https:\/\/example\.test\/x\?&quot;y&quot;\/docs\/host-integration\.md/,
    );
    assert.doesNotMatch(html, /https:\/\/example\.test\/x\?"y"/);
  });

  it("catalog points at live core and pending SDK publish wording", () => {
    const catalog = docsHubCatalog();
    assert.ok(
      catalog.sections[0]?.links[0]?.href.startsWith(DEFAULT_DOCS_REPO_BASE),
    );
    assert.equal(LIVE_CORE_NPM_VERSION, "0.1.1");
    assert.equal(LIVE_SDK_NPM_VERSION, "0.1.0");
    assert.equal(SDK_MAIN_VERSION, "0.1.1");
    assert.ok(catalog.footer.some((l) => l.href === DEFAULT_WIKI_BASE));
    assert.ok(
      catalog.packages.some((l) =>
        /after #40 publish/i.test(l.label + (l.hint ?? "")),
      ),
    );
  });
});
