import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DOCS_REPO_BASE,
  docsHubCatalog,
  renderDocsHubPage,
} from "./docs-hub.js";

describe("renderDocsHubPage", () => {
  it("renders Connect brand, step strip IA, and links existing docs", () => {
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
    assert.match(html, /@inboxlink\/sdk/);
    assert.match(html, /npmjs\.com\/package\/@inboxlink\/sdk/);
    assert.match(html, /Fraunces/);
    assert.match(html, /--accent:\s*#0f6e56/);
    assert.match(html, /class="shell docs-shell"/);
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

  it("catalog points at the public GitHub blob base by default", () => {
    const catalog = docsHubCatalog();
    assert.ok(
      catalog.sections[0]?.links[0]?.href.startsWith(DEFAULT_DOCS_REPO_BASE),
    );
  });
});
