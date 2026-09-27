import { escapeHtml, renderPublicDocument } from "@inboxlink/connect-ui";
import type { HealthBody } from "./health.js";

/** Status-only CSS layered on CONNECT_STYLES via renderPublicDocument (direction C). */
const STATUS_STYLES = /* css */ `
.shell-status {
  max-width: 32rem;
  margin: 0 auto;
}

.shell-status .brand {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.65rem, 4vw, 2.15rem);
  letter-spacing: -0.02em;
  margin: 0 0 0.35rem;
  animation: rise 520ms ease-out both;
}

.shell-status .brand span {
  color: var(--accent);
}

.shell-status .main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem 0 2rem;
}

.shell-status .panel {
  width: min(100%, 28rem);
  animation: rise 640ms 60ms ease-out both;
}

.shell-status .footer {
  color: var(--muted);
  font-size: 0.8rem;
  text-align: center;
  animation: rise 800ms 160ms ease-out both;
}

.status-chip {
  display: inline-block;
  margin: 0 0 0.85rem;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
  animation: rise 520ms ease-out both;
}
.status-chip.warn { color: var(--warn); }
.status-chip.danger { color: var(--danger); }

.health-rows {
  margin: 0 0 1.35rem;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
  animation: rise 640ms 60ms ease-out both;
}
.health-rows li {
  display: grid;
  grid-template-columns: 7.5rem 1fr;
  gap: 0.75rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--line);
  font-size: 0.95rem;
}
.health-rows .key {
  color: var(--muted);
  font-weight: 600;
  font-size: 0.8rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  align-self: center;
}
.health-rows .val {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--ink);
  word-break: break-word;
}
.health-rows .val.ok { color: var(--accent); font-weight: 650; }
.health-rows .val.warn { color: var(--warn); font-weight: 650; }
.health-rows .val.danger { color: var(--danger); font-weight: 650; }

.json-link {
  display: inline-block;
  margin-top: 0.25rem;
  color: var(--accent);
  font-weight: 650;
  text-decoration: none;
  border-bottom: 1px solid rgba(15, 110, 86, 0.35);
}
.json-link:hover { color: var(--accent-hover); }
.json-link:focus-visible {
  outline: 3px solid #7bc9b0;
  outline-offset: 3px;
}

@media (prefers-reduced-motion: reduce) {
  .shell-status .brand,
  .shell-status .panel,
  .shell-status .footer,
  .status-chip,
  .health-rows {
    animation: none;
  }
}
`;

export type StatusPageInput = {
  health: HealthBody;
  /** Absolute or root-relative URL for the canonical JSON health probe. */
  healthJsonHref?: string;
};

function toneFor(health: HealthBody): "ok" | "warn" | "danger" {
  if (!health.ok || health.error) return "danger";
  if (health.warning) return "warn";
  return "ok";
}

function headline(health: HealthBody): { chip: string; title: string; lead: string } {
  const tone = toneFor(health);
  if (tone === "danger") {
    return {
      chip: "Unavailable",
      title: "Service not ready",
      lead: "InboxLink cannot confirm a healthy store. Do not run Connect until JSON health reports ok and store=postgres.",
    };
  }
  if (tone === "warn") {
    return {
      chip: "Degraded",
      title: "Ephemeral store",
      lead: "The API is up, but the grant store is in-memory. Production Connect needs Postgres.",
    };
  }
  return {
    chip: "Healthy",
    title: "InboxLink is up",
    lead: "Safe operator view of the same probe as GET /health. No secrets are shown here.",
  };
}

function row(key: string, value: string, valueClass?: string): string {
  const cls = valueClass ? `val ${valueClass}` : "val";
  return `<li><span class="key">${escapeHtml(key)}</span><span class="${cls}">${escapeHtml(value)}</span></li>`;
}

/**
 * Human-readable status HTML (direction C). Consumes the canonical health body;
 * does not replace GET /health JSON. Uses shared `renderPublicDocument` from connect-ui.
 */
export function renderStatusPage(input: StatusPageInput): string {
  const health = input.health;
  const href = escapeHtml(input.healthJsonHref ?? "/health");
  const tone = toneFor(health);
  const copy = headline(health);
  const chipClass = tone === "ok" ? "status-chip" : `status-chip ${tone}`;
  const okClass = tone === "ok" ? "ok" : tone;

  const rows: string[] = [
    row("ok", String(health.ok), okClass),
    row("service", health.service),
    row("store", health.store, health.store === "postgres" ? "ok" : "warn"),
    row("mode", health.mode),
  ];
  if (health.queue !== undefined) {
    rows.push(row("queue", health.queue));
  }
  if (health.error) {
    rows.push(row("error", health.error, "danger"));
  }
  if (health.warning) {
    rows.push(row("warning", health.warning, "warn"));
  }

  const notice =
    health.guidance != null && health.guidance !== ""
      ? `<p class="notice ${tone === "danger" ? "danger" : "warn"}">${escapeHtml(health.guidance)}</p>`
      : "";

  const body = `
    <header>
      <p class="brand">Inbox<span>Link</span></p>
    </header>
    <main class="main">
      <div class="panel">
        <p class="${chipClass}">${escapeHtml(copy.chip)}</p>
        <p class="kicker">Operator status</p>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="lead">${escapeHtml(copy.lead)}</p>
        <ul class="health-rows" data-testid="status-health-rows">
          ${rows.join("\n          ")}
        </ul>
        ${notice}
        <p class="meta"><a class="json-link" data-testid="status-health-json" href="${href}">Machine JSON → /health</a></p>
      </div>
    </main>
    <footer class="footer">Mailbox connection infrastructure · read-only access</footer>
  `;

  return renderPublicDocument({
    title: "InboxLink · Status",
    body,
    extraStyles: STATUS_STYLES,
    shellClass: "shell-status",
    statusRole: "status",
  });
}
