import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";
import { LANDING_STYLES } from "./landing-styles.js";

export type LandingPageLinks = {
  githubUrl?: string;
  /** Hosted docs hub (default `/docs`). */
  docsHubUrl?: string;
  wikiUrl?: string;
  /** Live npm package page (default core@0.1.1). */
  npmCoreUrl?: string;
  healthPath?: string;
  /** @deprecated Prefer docsHubUrl; still accepted for tests/overrides. */
  hostDocsUrl?: string;
  /** @deprecated Prefer npmCoreUrl. */
  npmSdkUrl?: string;
};

const DEFAULT_GITHUB = "https://github.com/EtienneFokou-E18560/inboxlink";
const DEFAULT_DOCS_HUB = "/docs";
const DEFAULT_WIKI = "https://github.com/EtienneFokou-E18560/inboxlink/wiki";
const DEFAULT_NPM_CORE = "https://www.npmjs.com/package/@inboxlink/core/v/0.1.1";
const DEFAULT_HEALTH = "/health";

/**
 * Developer-facing Vault door landing (`GET /home`).
 * Brand-first InboxLink, one promise, CTAs to GitHub + docs + wiki + live npm core.
 */
export function renderLandingPage(links: LandingPageLinks = {}): string {
  const githubUrl = escapeHtml(links.githubUrl ?? DEFAULT_GITHUB);
  const docsHubUrl = escapeHtml(
    links.docsHubUrl ?? links.hostDocsUrl ?? DEFAULT_DOCS_HUB,
  );
  const wikiUrl = escapeHtml(links.wikiUrl ?? DEFAULT_WIKI);
  const npmCoreUrl = escapeHtml(
    links.npmCoreUrl ?? links.npmSdkUrl ?? DEFAULT_NPM_CORE,
  );
  const healthPath = escapeHtml(links.healthPath ?? DEFAULT_HEALTH);

  const flow = escapeHtml(`npm i @inboxlink/core@0.1.1   # live
npm i @inboxlink/sdk         # 0.1.0 today; filters after publish
session → connect → grantId → messages
filters: Production HTTP + main (SDK helpers pending)`);

  const body = `
    <p class="brand-hero">Inbox<span>Link</span></p>
    <p class="promise">Connect mailboxes without holding tokens.</p>
    <div class="cta-row">
      <a class="cta" data-testid="landing-github" href="${githubUrl}">View on GitHub</a>
      <a class="cta-secondary" data-testid="landing-docs" href="${docsHubUrl}">Docs hub</a>
      <a class="cta-secondary" data-testid="landing-wiki" href="${wikiUrl}">Wiki</a>
      <a class="cta-secondary" data-testid="landing-npm" href="${npmCoreUrl}">npm core@0.1.1</a>
    </div>
    <pre class="flow" data-testid="landing-flow" aria-label="Install and product flow">${flow}</pre>
    <p class="landing-footer">Open-source mailbox connection infrastructure · <a href="${healthPath}">JSON health</a> stays at <code>/health</code> · human <a href="/status">/status</a></p>
  `;

  return renderPublicDocument({
    title: "InboxLink",
    body,
    extraStyles: LANDING_STYLES,
    shellClass: "shell-landing",
  });
}
