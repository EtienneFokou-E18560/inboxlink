# @inboxlink/connect-ui

Hosted **Connect inbox** UI (Plaid Link analog) plus shared public HTML helpers.

Exports HTML renderers used by `@inboxlink/server` at `/v1/connect/:linkToken`, OAuth error paths, and the developer landing at `/home`. Pages are rendered as strings and returned with Hono `c.html()` — the Vercel deployment routes all traffic through the API function, so filesystem `serveStatic` is not used.

Shared tokens live in `CONNECT_STYLES` / `src/public/` so landing, `/status`, and `/docs` can reuse ink/teal + Fraunces/Figtree without inventing a second brand.

## API

- `renderConnectPage({ authUrl, expiresAt })` — pending session CTA
- `renderConnectErrorPage({ kind, detail? })` — expired / invalid / OAuth failures
- `connectErrorStatus(kind)` — suggested HTTP status
- `renderPublicDocument({ title, body, extraStyles? })` — shared HTML shell for public pages
- `CONNECT_STYLES` — design tokens
- `INBOXLINK_WEBSITE_URL` — the website (`GET /home` and `GET /docs` redirect there)

Do not depend on career-workspace.
