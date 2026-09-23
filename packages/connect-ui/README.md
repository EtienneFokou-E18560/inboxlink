# @inboxlink/connect-ui

Hosted **Connect inbox** UI (Plaid Link analog).

Exports HTML renderers used by `@inboxlink/server` at `/v1/connect/:linkToken` and on OAuth error paths. Pages are rendered as strings and returned with Hono `c.html()` — the Vercel deployment routes all traffic through the API function, so filesystem `serveStatic` is not used.

## API

- `renderConnectPage({ authUrl, expiresAt })` — pending session CTA
- `renderConnectErrorPage({ kind, detail? })` — expired / invalid / OAuth failures
- `connectErrorStatus(kind)` — suggested HTTP status

Do not depend on career-workspace.
