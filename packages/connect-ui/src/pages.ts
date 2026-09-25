import { escapeHtml } from "./escape.js";
import { renderShell } from "./shell.js";

export type ConnectPageProps = {
  /** Absolute Google (or provider) authorization URL. */
  authUrl: string;
  /** ISO-8601 session expiry. */
  expiresAt: string;
  /** Provider button label, default Google. */
  providerLabel?: string;
};

export type ConnectErrorKind =
  | "expired"
  | "invalid"
  | "session_completed"
  | "session_failed"
  | "session_other"
  | "oauth_denied"
  | "oauth_missing"
  | "oauth_unknown_state"
  | "oauth_exchange"
  | "oauth_missing_refresh"
  | "vault_failed";

export type ConnectErrorPageProps = {
  kind: ConnectErrorKind;
  /** Extra detail shown under the lead (already human-readable). */
  detail?: string;
  /** Raw provider error code for oauth_denied. */
  providerError?: string;
  /** Session status string when kind is session_other. */
  sessionStatus?: string;
};

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "soon";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/** Pending Link session — CTA into provider OAuth. */
export function renderConnectPage(props: ConnectPageProps): string {
  const provider = escapeHtml(props.providerLabel ?? "Google");
  const authUrl = escapeHtml(props.authUrl);
  const expires = escapeHtml(formatExpiry(props.expiresAt));
  const body = `
    <p class="kicker">Secure connect</p>
    <h1 id="connect-heading">Connect your inbox</h1>
    <p class="lead" id="connect-lead">InboxLink asks for <strong>read-only</strong> Gmail access so your host app can sync mail. The refresh token stays vaulted here — the host never sees it.</p>
    <p><a class="cta" data-testid="connect-cta" href="${authUrl}" aria-describedby="connect-lead connect-expiry">Continue with ${provider}</a></p>
    <p class="meta" id="connect-expiry">This link expires <time datetime="${escapeHtml(props.expiresAt)}">${expires}</time>. If it expires, return to the app that sent you here and start a new connect.</p>
  `;
  return renderShell({ title: "InboxLink Connect", body });
}

/** Error / terminal states for Connect and OAuth callback. */
export function renderConnectErrorPage(props: ConnectErrorPageProps): string {
  const copy = errorCopy(props);
  const noticeClass = copy.tone === "danger" ? "notice danger" : copy.tone === "warn" ? "notice warn" : "notice";
  const detail = props.detail
    ? `<p class="${noticeClass}">${escapeHtml(props.detail)}</p>`
    : copy.notice
      ? `<p class="${noticeClass}">${escapeHtml(copy.notice)}</p>`
      : "";
  const body = `
    <p class="kicker">${escapeHtml(copy.kicker)}</p>
    <h1>${escapeHtml(copy.title)}</h1>
    <p class="lead">${escapeHtml(copy.lead)}</p>
    ${detail}
    <p class="meta">${escapeHtml(copy.meta)}</p>
  `;
  return renderShell({
    title: `InboxLink · ${copy.title}`,
    body,
    statusRole: "alert",
  });
}

function errorCopy(props: ConnectErrorPageProps): {
  kicker: string;
  title: string;
  lead: string;
  notice?: string;
  meta: string;
  tone: "neutral" | "warn" | "danger";
} {
  switch (props.kind) {
    case "expired":
      return {
        kicker: "Session expired",
        title: "This connect link has expired",
        lead: "For security, connect links only work for a short time.",
        notice: "Return to the app that opened InboxLink and request a new connect link.",
        meta: "No mailbox was connected. Your previous session cannot be reused.",
        tone: "warn",
      };
    case "invalid":
      return {
        kicker: "Link not found",
        title: "This connect link is invalid",
        lead: "The link may be incomplete, already removed, or typed incorrectly.",
        notice: "Open Connect from your host app again to get a fresh link.",
        meta: "If you keep seeing this, ask the app developer to check their Link session creation.",
        tone: "danger",
      };
    case "session_completed":
      return {
        kicker: "Already connected",
        title: "This session already finished",
        lead: "The mailbox was connected successfully. You can close this tab.",
        notice: "Starting again needs a new connect link from the host app.",
        meta: "Reusing an old link does not reconnect or refresh tokens.",
        tone: "neutral",
      };
    case "session_failed":
      return {
        kicker: "Session ended",
        title: "This connect session failed",
        lead: "Something went wrong earlier in this session, so it can no longer continue.",
        notice: "Return to the host app and start Connect again.",
        meta: "If this keeps happening, check the OAuth client configuration.",
        tone: "danger",
      };
    case "session_other":
      return {
        kicker: "Unavailable",
        title: "This connect session cannot continue",
        lead: `Current status: ${props.sessionStatus ?? "unknown"}.`,
        notice: "Ask the host app for a new connect link.",
        meta: "Only pending sessions can start Gmail authorization.",
        tone: "warn",
      };
    case "oauth_denied":
      return {
        kicker: "Authorization canceled",
        title: "Google access was not granted",
        lead: "You declined permission, or Google returned an OAuth error.",
        notice: props.providerError
          ? `Provider said: ${props.providerError}`
          : "No mailbox was connected.",
        meta: "You can close this tab and try again from the host app when ready.",
        tone: "warn",
      };
    case "oauth_missing":
      return {
        kicker: "Incomplete callback",
        title: "Missing authorization details",
        lead: "Google did not return both a code and state, so Connect cannot finish.",
        notice: "Start Connect again from the host app.",
        meta: "Do not bookmark the callback URL — it is only valid once.",
        tone: "danger",
      };
    case "oauth_unknown_state":
      return {
        kicker: "Session mismatch",
        title: "This OAuth return does not match a live session",
        lead: "The state token is unknown or the Link session expired while you were at Google.",
        notice: "Return to the host app and open a fresh connect link.",
        meta: "On multi-instance deploys, durable session storage (Postgres) is required.",
        tone: "warn",
      };
    case "oauth_exchange":
      return {
        kicker: "Token exchange failed",
        title: "Google did not accept the authorization",
        lead: "InboxLink could not exchange the code for tokens.",
        meta: "Fix the OAuth client or redirect URI, then start Connect again.",
        tone: "danger",
      };
    case "oauth_missing_refresh":
      return {
        kicker: "Re-consent required",
        title: "Google did not return a refresh token",
        lead: "Offline access was not granted, so InboxLink cannot keep the mailbox connected.",
        notice:
          "Return to the host app, open a fresh connect link, and approve Google access again when prompted. Do not skip the consent screen.",
        meta: "No grant was created. Re-consent is required before Connect can finish.",
        tone: "warn",
      };
    case "vault_failed":
      return {
        kicker: "Vault error",
        title: "Could not store the refresh token",
        lead: "Authorization succeeded, but sealing the token failed.",
        notice:
          "Set INBOXLINK_MASTER_KEY to at least 16 characters, redeploy, and start Connect again.",
        meta: "No grant was left behind for this attempt.",
        tone: "danger",
      };
  }
}

/** HTTP status recommended for each error kind. */
export function connectErrorStatus(kind: ConnectErrorKind): 400 | 404 | 500 {
  switch (kind) {
    case "invalid":
    case "expired":
      return 404;
    case "vault_failed":
      return 500;
    default:
      return 400;
  }
}
