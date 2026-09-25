# Security Policy

## Supported versions

| Component | Supported |
|-----------|-----------|
| Latest `main` (self-host / Production deploy) | Yes |
| Published `@inboxlink/sdk` / `@inboxlink/core` (0.x while pre-1.0) | Yes — latest release on npm (`0.1.1`+) |
| Older unpublished / forked trees | Best-effort only |

Microsoft Graph and IMAP adapters are parked and out of scope for security support until unparked.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports** (especially anything involving OAuth tokens, vault keys, API secrets, or access to mailbox data).

Prefer **GitHub Private Vulnerability Reporting** on this repository:

1. Open the repository **Security** tab → **Advisories** → **Report a vulnerability**  
   (or enable Private Vulnerability Reporting in Settings if the button is missing).
2. Include: impact, affected component (SDK vs server vs Connect), reproduction steps, and whether Production or a self-host was involved.
3. Do **not** attach live refresh tokens, master keys, or full message bodies.

We aim to acknowledge reports within a few business days and to coordinate disclosure after a fix is available (or after a reasonable window if no fix is needed).

## Scope notes

In scope examples: auth bypass, vault/ciphertext handling flaws, token leakage via logs or API responses, privilege issues between tenants in `multi` mode, supply-chain issues in published `@inboxlink/*` packages.

Out of scope examples: compromise of a user’s Google account, host applications that log `public_token` or grant IDs insecurely, misconfigured self-hosts (weak `INBOXLINK_MASTER_KEY`, missing Postgres, placeholder secrets in multi mode), and third-party dependency CVEs already tracked by Dependabot unless InboxLink usage makes them exploitable in a novel way.

## Maintainers

Operators of Production and npm publishers should keep account 2FA enabled, prefer npm Trusted Publishing (OIDC) over long-lived tokens, and never commit secrets.
