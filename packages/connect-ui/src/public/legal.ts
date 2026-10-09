import { escapeHtml } from "../escape.js";
import { renderPublicDocument } from "./document.js";

export type LegalPageOptions = {
  /** Where people report issues or ask for deletion (a URL or mailto:). */
  contactUrl?: string;
  updated?: string;
};

const DEFAULT_CONTACT = "https://github.com/EtienneFokou-E18560/inboxlink/security/advisories/new";
const UPDATED = "2026-10-08";

const LEGAL_STYLES = `
  .legal { max-width: 46rem; margin: 0 auto; line-height: 1.6; }
  .legal h1 { font-family: Fraunces, Georgia, serif; font-size: 2rem; margin: 0 0 .25rem; }
  .legal h2 { font-size: 1.1rem; margin: 1.75rem 0 .35rem; }
  .legal p, .legal li { color: inherit; }
  .legal .meta { opacity: .75; font-size: .9rem; margin-bottom: 1.5rem; }
  .legal ul { padding-left: 1.2rem; }
  .legal nav { margin-top: 2rem; font-size: .95rem; }
`;

function page(title: string, intro: string, sections: Array<[string, string]>, opts: LegalPageOptions): string {
  const contact = escapeHtml(opts.contactUrl ?? DEFAULT_CONTACT);
  const body = `
    <main class="legal">
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Last updated ${escapeHtml(opts.updated ?? UPDATED)}</p>
      <p>${intro}</p>
      ${sections.map(([h, html]) => `<h2>${escapeHtml(h)}</h2>${html}`).join("\n")}
      <h2>Contact</h2>
      <p>Questions, security reports, or requests to delete data: <a href="${contact}">${contact}</a>.</p>
      <nav><a href="/home">Home</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/status">Status</a></nav>
    </main>`;
  return renderPublicDocument({ title: `${title} · InboxLink`, body, extraStyles: LEGAL_STYLES });
}

export function renderPrivacyPage(opts: LegalPageOptions = {}): string {
  return page(
    "Privacy",
    "InboxLink connects a mailbox to an app that you use. This page explains what InboxLink stores and why. It is a plain-language summary of how the service works.",
    [
      [
        "What we receive",
        `<ul>
          <li>The mailbox address and the permission you grant (read-only access to Gmail, or the equivalent for other providers) when you connect.</li>
          <li>A long-lived refresh credential from the provider, used only to read the mailbox for the app you connected it to.</li>
          <li>Message data needed for that app: sender, recipients, subject, a short snippet, labels, dates and, when requested, the body and attachment names. Attachment contents are not fetched.</li>
        </ul>`,
      ],
      [
        "How it is used",
        `<p>Only to provide the mailbox connection to the app you connected, and to keep it in sync. We do not sell data, use it for advertising, or use it to train models. People working on the service do not read your mail except where you ask for support, where security requires it, or where the law requires it.</p>
         <p>InboxLink's use and transfer to any other app of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>`,
      ],
      [
        "How it is protected",
        `<p>Refresh credentials are encrypted at rest (AES-256-GCM) and are never returned by the API. The host app receives an opaque grant ID, not your credential. Logs redact tokens and secrets. Data is stored in a managed Postgres database.</p>`,
      ],
      [
        "Who receives it",
        `<p>The app you connected the mailbox to receives message data through the API and, if it registered one, signed webhook events (event type, grant and message identifiers, and the subject line). The service runs on Vercel and a managed Postgres provider as infrastructure processors. Nothing else receives your data.</p>`,
      ],
      [
        "Keeping and deleting",
        `<p>Data is kept while the connection is active. Disconnecting (revoking the grant) deletes the stored credential and the stored messages for that connection. You can also revoke InboxLink's access from your Google account permissions page at any time, which stops all access immediately. To ask for deletion, use the contact below.</p>`,
      ],
    ],
    opts,
  );
}

export function renderTermsPage(opts: LegalPageOptions = {}): string {
  return page(
    "Terms",
    "These terms cover use of this InboxLink deployment. InboxLink is open-source software released under the MIT license; the license covers the code, these terms cover the hosted service.",
    [
      [
        "Use of the service",
        `<p>The hosted service is provided to developers and the people who connect mailboxes to their apps. Do not use it to access mailboxes you are not authorised to access, to send spam, to probe or disrupt the service, or to break the law or a provider's terms.</p>`,
      ],
      [
        "Access and keys",
        `<p>API keys belong to the tenant they were issued to and must be kept server-side. You are responsible for activity under your keys. We may suspend access that threatens the service or other users.</p>`,
      ],
      [
        "Availability",
        `<p>The service is in beta and provided as is, without warranty of any kind. It may change, be interrupted, or be withdrawn. Webhook deliveries are best effort and are not guaranteed; reconcile using the API.</p>`,
      ],
      [
        "Liability",
        `<p>To the extent the law allows, the operator is not liable for indirect or consequential loss, or for loss of data or business, arising from use of the service.</p>`,
      ],
      [
        "Changes",
        `<p>We may update these terms; continued use after an update means you accept it. The date above shows the latest revision.</p>`,
      ],
    ],
    opts,
  );
}
