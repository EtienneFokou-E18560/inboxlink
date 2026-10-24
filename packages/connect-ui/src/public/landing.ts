import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";
import { LANDING_STYLES } from "./landing-styles.js";
import { INBOXLINK_WEBSITE_URL } from "./website.js";

export type LandingPageLinks = {
  githubUrl?: string;
  websiteUrl?: string;
  npmUrl?: string;
  healthPath?: string;
};

const DEFAULT_GITHUB = "https://github.com/EtienneFokou-E18560/inboxlink";
const DEFAULT_NPM = "https://www.npmjs.com/package/@inboxlink/sdk";
const DEFAULT_HEALTH = "/health";

/**
 * `GET /home`: the API domain's home page for people who land here; the docs live on the website.
 * (Google's consent screen is branded Askel and names getaskel.com as its home page, not this page.)
 */
export function renderLandingPage(links: LandingPageLinks = {}): string {
  const githubUrl = escapeHtml(links.githubUrl ?? DEFAULT_GITHUB);
  const websiteUrl = escapeHtml(links.websiteUrl ?? INBOXLINK_WEBSITE_URL);
  const npmUrl = escapeHtml(links.npmUrl ?? DEFAULT_NPM);
  const healthPath = escapeHtml(links.healthPath ?? DEFAULT_HEALTH);

  const flow = escapeHtml(`npm i @inboxlink/sdk
session → connect → grantId → messages
events: grant.connected · message.created · sync.completed`);

  const body = `
    <p class="brand-hero">Inbox<span>Link</span></p>
    <p class="promise">Connect mailboxes without holding tokens.</p>
    <p class="landing-lead">InboxLink lets apps read a person's Gmail with their permission, read-only, without the app ever holding their Google token. Connected your mailbox to an app? <a href="${websiteUrl}/for-mailbox-owners/">See what it can access and how to disconnect</a>.</p>
    <div class="cta-row">
      <a class="cta" data-testid="landing-website" href="${websiteUrl}">Website and docs</a>
      <a class="cta-secondary" data-testid="landing-github" href="${githubUrl}">GitHub</a>
      <a class="cta-secondary" data-testid="landing-npm" href="${npmUrl}">npm</a>
    </div>
    <pre class="flow" data-testid="landing-flow" aria-label="Install and product flow">${flow}</pre>
    <p class="landing-footer">Open-source mailbox connection infrastructure · <a href="${healthPath}">JSON health</a> stays at <code>/health</code> · human <a href="/status">/status</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
  `;

  return renderPublicDocument({
    title: "InboxLink",
    body,
    extraStyles: LANDING_STYLES,
    shellClass: "shell-landing",
  });
}
