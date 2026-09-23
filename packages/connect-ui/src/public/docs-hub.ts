import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";
import { DOCS_HUB_STYLES } from "./docs-hub-styles.js";

/** Public GitHub tree for linking in-repo markdown (not duplicated here). */
export const DEFAULT_DOCS_REPO_BASE =
  "https://github.com/EtienneFokou-E18560/inboxlink/blob/main";

export const DEFAULT_DOCS_TREE_BASE =
  "https://github.com/EtienneFokou-E18560/inboxlink/tree/main";

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
            hint: "@inboxlink/sdk",
          },
        ],
      },
      {
        id: "messages",
        title: "Messages",
        lead: "List and sync normalized messages with the grant. Revoke when the user disconnects.",
        links: [
          {
            href: `${hostGuide}#4-use-the-grant-messages`,
            label: "Messages API in the host guide",
            hint: "list / get / sync",
          },
          {
            href: sdkReadme,
            label: "SDK — messages helpers",
            hint: "packages/sdk/README.md",
          },
        ],
      },
    ],
    packages: [
      {
        href: "https://www.npmjs.com/package/@inboxlink/sdk",
        label: "@inboxlink/sdk",
        hint: "Host HTTP client (npm)",
      },
      {
        href: "https://www.npmjs.com/package/@inboxlink/core",
        label: "@inboxlink/core",
        hint: "Types and crypto helpers (npm)",
      },
      {
        href: sdkReadme,
        label: "SDK source README",
        hint: "until / after publish",
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
      <p>Install the host SDK; open the READMEs for API shape. Prefer the docs above over copying long samples here.</p>
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
        <p class="lead">Follow the same path your integration takes. Each step links the existing guides in the repository — this page does not rewrite them.</p>
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
