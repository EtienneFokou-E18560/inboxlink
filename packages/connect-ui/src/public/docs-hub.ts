import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";
import { DOCS_HUB_STYLES } from "./docs-hub-styles.js";

/** Public GitHub tree for linking in-repo markdown (not duplicated here). */
export const DEFAULT_DOCS_REPO_BASE =
  "https://github.com/EtienneFokou-E18560/inboxlink/blob/main";

export const DEFAULT_DOCS_TREE_BASE =
  "https://github.com/EtienneFokou-E18560/inboxlink/tree/main";

export const DEFAULT_WIKI_BASE =
  "https://github.com/EtienneFokou-E18560/inboxlink/wiki";

/** Pinned host SDK / core release for install CTAs. */
export const PINNED_NPM_VERSION = "0.1.1";

export type DocsHubLink = {
  href: string;
  label: string;
  hint?: string;
};

export type DocsHubOptions = {
  /** Override blob base (tests / mirrors). */
  repoBlobBase?: string;
  /** Override tree base for directories. */
  repoTreeBase?: string;
};

function blob(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function tree(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** Stable catalog used by the hub and by tests. */
export function docsHubCatalog(opts: DocsHubOptions = {}): {
  steps: DocsHubLink[];
  sections: { id: string; title: string; lead: string; links: DocsHubLink[] }[];
  packages: DocsHubLink[];
  footer: DocsHubLink[];
} {
  const blobBase = opts.repoBlobBase ?? DEFAULT_DOCS_REPO_BASE;
  const treeBase = opts.repoTreeBase ?? DEFAULT_DOCS_TREE_BASE;

  const hostGuide = blob(blobBase, "docs/host-integration.md");
  const sdkReadme = blob(blobBase, "packages/sdk/README.md");
  const examples = tree(treeBase, "examples/host-integration");
  const readme = blob(blobBase, "README.md");
  const ops = blob(blobBase, "docs/ops-runbook.md");
  const publishing = blob(blobBase, "docs/publishing.md");
  const coreReadme = blob(blobBase, "packages/core/README.md");
  const security = blob(blobBase, "SECURITY.md");
  const wiki = DEFAULT_WIKI_BASE;
  const sdkNpm = `https://www.npmjs.com/package/@inboxlink/sdk/v/${PINNED_NPM_VERSION}`;
  const coreNpm = `https://www.npmjs.com/package/@inboxlink/core/v/${PINNED_NPM_VERSION}`;

  return {
    steps: [
      { href: "#host", label: "Host" },
      { href: "#connect", label: "Connect" },
      { href: "#grant", label: "Grant" },
      { href: "#messages", label: "Messages" },
    ],
    sections: [
      {
        id: "host",
        title: "Host",
        lead: "Create a Connect session from your backend. Hosts never set GOOGLE_* or hold refresh tokens.",
        links: [
          { href: hostGuide, label: "Host integration guide", hint: "docs/host-integration.md" },
          {
            href: `${wiki}/Quick-start`,
            label: "Wiki — Quick start",
            hint: "scannable host portal",
          },
          {
            href: examples,
            label: "Host integration examples",
            hint: "curl + SDK sketches",
          },
          {
            href: sdkReadme,
            label: "SDK README — createConnectSession",
            hint: "packages/sdk/README.md",
          },
        ],
      },
      {
        id: "connect",
        title: "Connect",
        lead: "Send the user to connectUrl. InboxLink hosts the browser Connect page and Gmail OAuth.",
        links: [
          {
            href: `${hostGuide}#2-redirect-the-user-to-connect`,
            label: "Redirect the user to Connect",
            hint: "host-integration.md §2",
          },
          {
            href: `${wiki}/Connect-flow`,
            label: "Wiki — Connect flow",
            hint: "Host → Connect → Grant → Messages",
          },
          {
            href: readme,
            label: "Architecture overview",
            hint: "README.md",
          },
        ],
      },
      {
        id: "grant",
        title: "Grant",
        lead: "Exchange the one-time public_token for a durable grantId. Store only the grantId.",
        links: [
          {
            href: `${hostGuide}#3-exchange-public_token--grantid`,
            label: "Exchange public_token → grantId",
            hint: "host-integration.md §3",
          },
          {
            href: sdkReadme,
            label: "SDK — completeConnect",
            hint: `@inboxlink/sdk@${PINNED_NPM_VERSION}`,
          },
        ],
      },
      {
        id: "messages",
        title: "Messages",
        lead:
          "List and sync normalized messages with the grant. Filters (q, from/to/subject, label, includeSpamTrash) ship in @inboxlink/sdk@0.1.1. Revoke when the user disconnects.",
        links: [
          {
            href: `${hostGuide}#4-use-the-grant-messages`,
            label: "Messages API in the host guide",
            hint: "list / get / sync",
          },
          {
            href: `${wiki}/Messages-API`,
            label: "Wiki — Messages API + filters",
            hint: "q · from/to/subject · label",
          },
          {
            href: sdkReadme,
            label: "SDK — messages helpers",
            hint: `packages/sdk · ${PINNED_NPM_VERSION}`,
          },
        ],
      },
    ],
    packages: [
      {
        href: sdkNpm,
        label: `@inboxlink/sdk@${PINNED_NPM_VERSION}`,
        hint: "npm i @inboxlink/sdk@0.1.1 · filters included",
      },
      {
        href: coreNpm,
        label: `@inboxlink/core@${PINNED_NPM_VERSION}`,
        hint: "npm companion types / crypto",
      },
      {
        href: `${wiki}/SDK`,
        label: "Wiki — SDK",
        hint: "install + surface for 0.1.1",
      },
      {
        href: sdkReadme,
        label: "SDK source README",
        hint: "packages/sdk/README.md",
      },
      {
        href: coreReadme,
        label: "Core source README",
        hint: "packages/core",
      },
      {
        href: publishing,
        label: "Publishing notes",
        hint: "docs/publishing.md",
      },
    ],
    footer: [
      { href: "/home", label: "Home" },
      { href: "/status", label: "Status" },
      { href: "/health", label: "Health JSON" },
      { href: wiki, label: "Wiki" },
      { href: ops, label: "Ops runbook" },
      { href: security, label: "Security" },
      {
        href: "https://github.com/EtienneFokou-E18560/inboxlink",
        label: "GitHub",
      },
    ],
  };
}

function renderLinkList(links: DocsHubLink[]): string {
  const items = links
    .map((link) => {
      const hint = link.hint
        ? `<span class="hint">${escapeHtml(link.hint)}</span>`
        : "";
      return `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${hint}</li>`;
    })
    .join("\n");
  return `<ul class="doc-links">${items}</ul>`;
}

/**
 * Public docs hub HTML — links existing in-repo docs with Connect brand + Link-stripe IA.
 * Uses shared `renderPublicDocument` (same shell as landing/status).
 */
export function renderDocsHubPage(opts: DocsHubOptions = {}): string {
  const catalog = docsHubCatalog(opts);

  const stepItems = catalog.steps
    .map((step, i) => {
      const arrow =
        i < catalog.steps.length - 1
          ? `<span class="arrow" aria-hidden="true">→</span>`
          : "";
      return `<li><a href="${escapeHtml(step.href)}">${escapeHtml(step.label)}</a>${arrow}</li>`;
    })
    .join("");

  const sections = catalog.sections
    .map(
      (section) => `
    <section class="doc-section" id="${escapeHtml(section.id)}">
      <h2>${escapeHtml(section.title)}</h2>
      <p>${escapeHtml(section.lead)}</p>
      ${renderLinkList(section.links)}
    </section>`,
    )
    .join("");

  const packages = `
    <section class="doc-section" id="packages">
      <h2>Packages</h2>
      <p>Pin <code>@inboxlink/sdk@${escapeHtml(PINNED_NPM_VERSION)}</code> / <code>@inboxlink/core@${escapeHtml(PINNED_NPM_VERSION)}</code>. Message list filters landed in that release. Prefer the wiki + guides above over copying long samples here.</p>
      ${renderLinkList(catalog.packages)}
    </section>`;

  const footerNav = catalog.footer
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join("\n");

  const body = `
    <header>
      <p class="brand">Inbox<span>Link</span></p>
    </header>
    <main class="main">
      <div class="docs-panel" data-testid="docs-hub">
        <p class="kicker">Host docs</p>
        <h1>Connect mailboxes without holding tokens</h1>
        <p class="lead">Follow the same path your integration takes. Each step links the wiki and in-repo guides — this page does not rewrite them.</p>
        <ol class="step-strip" data-testid="docs-step-strip" aria-label="Integration steps">
          ${stepItems}
        </ol>
        ${sections}
        ${packages}
      </div>
    </main>
    <footer class="footer">
      <nav class="docs-footer-nav" aria-label="Related">
        ${footerNav}
      </nav>
      <p>Mailbox connection infrastructure · read-only access</p>
    </footer>
  `;

  return renderPublicDocument({
    title: "InboxLink · Docs",
    body,
    extraStyles: DOCS_HUB_STYLES,
    shellClass: "docs-shell",
  });
}
