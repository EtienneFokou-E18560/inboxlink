import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";
import { LANDING_STYLES } from "./landing-styles.js";

export type LandingPageLinks = {
  githubUrl?: string;
  hostDocsUrl?: string;
  healthPath?: string;
};

const DEFAULT_GITHUB = "https://github.com/EtienneFokou-E18560/inboxlink";
const DEFAULT_HOST_DOCS =
  "https://github.com/EtienneFokou-E18560/inboxlink/blob/main/docs/host-integration.md";
const DEFAULT_HEALTH = "/health";

/**
 * Developer-facing Vault door landing (`GET /home`).
 * Brand-first InboxLink, one promise, CTAs to GitHub + host docs + health.
 */
export function renderLandingPage(links: LandingPageLinks = {}): string {
  const githubUrl = escapeHtml(links.githubUrl ?? DEFAULT_GITHUB);
  const hostDocsUrl = escapeHtml(links.hostDocsUrl ?? DEFAULT_HOST_DOCS);
  const healthPath = escapeHtml(links.healthPath ?? DEFAULT_HEALTH);

  const flow = escapeHtml(`session → connect → grantId → messages
hosts never hold the refresh token`);

  const body = `
    <p class="brand-hero">Inbox<span>Link</span></p>
    <p class="promise">Connect mailboxes without holding tokens.</p>
    <div class="cta-row">
      <a class="cta" data-testid="landing-github" href="${githubUrl}">View on GitHub</a>
      <a class="cta-secondary" data-testid="landing-docs" href="${hostDocsUrl}">Host docs</a>
      <a class="cta-secondary" data-testid="landing-health" href="${healthPath}">Health / status</a>
    </div>
    <pre class="flow" data-testid="landing-flow" aria-label="Product flow">${flow}</pre>
    <p class="landing-footer">Open-source mailbox connection infrastructure · <a href="${healthPath}">JSON health</a> stays at <code>/health</code></p>
  `;

  return renderPublicDocument({
    title: "InboxLink",
    body,
    extraStyles: LANDING_STYLES,
    shellClass: "shell-landing",
  });
}
