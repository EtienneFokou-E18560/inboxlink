# `@inboxlink/sdk`

Host-app HTTP client for [InboxLink](https://github.com/EtienneFokou-E18560/inboxlink).

Gmail-first surface: Connect sessions, grant exchange, **list / get messages**, and **history sync**. Do **not** ship `INBOXLINK_API_SECRET` to browsers. This package does **not** add Microsoft Graph or IMAP client APIs.

**Hosts never set `GOOGLE_*`.** Google OAuth lives on the InboxLink server (Production or your self-host). Your app only needs a redirect URI you control plus (optionally) an API secret when the server is in `multi` mode.

## Install

```bash
npm install @inboxlink/sdk
```

Monorepo / git consumers can still use the workspace or a `file:` / git dependency. See [docs/publishing.md](../../docs/publishing.md) and [CHANGELOG.md](./CHANGELOG.md).

## Quick start (Production, single mode)

```ts
import { InboxLink, InboxLinkApiError } from "@inboxlink/sdk";

// baseUrl defaults to https://inboxlink-two.vercel.app
// apiSecret omitted — Production currently runs INBOXLINK_MODE=single
const il = new InboxLink();

const session = await il.createConnectSession({
  externalUserId: "user-1",
  redirectUri: "http://127.0.0.1:9999/done", // your host callback, not Google
});
// Redirect the end user to session.connectUrl

// On your redirect handler:
const { grantId } = await il.completeConnect({ redirectUrl: request.url });
const page = await il.messages.list(grantId, {
  limit: 20,
  q: "is:unread",
  label: "INBOX",
  from: "ada@example.com",
});
```

### Local / multi-mode overrides

```ts
const il = new InboxLink({
  baseUrl: process.env.INBOXLINK_BASE_URL ?? "http://localhost:8787",
  apiSecret: process.env.INBOXLINK_API_SECRET, // required when server is multi
});
```

## Client surface (v0.1, Gmail)

| Area | Methods | HTTP |
|------|---------|------|
| Connect | `createConnectSession`, `completeConnect` | sessions + exchange |
| Helpers | `parseConnectRedirect`, `connectUrlForToken`, `INBOXLINK_PRODUCTION_URL` | local |
| Link | `link.createSession` | `POST /v1/link/sessions` |
| Grants | `grants.exchange`, `grants.list`, `grants.revoke`, `grants.sync` | `/v1/grants…` |
| Messages | `messages.list`, `messages.get`, `messages.iterate` | `/v1/grants/:id/messages…` |
| Webhooks | `webhooks.verify` | local HMAC check |

- `messages.list` → live Gmail list (optional filters: `q`, `from`, `to`, `subject`, `label`, `includeSpamTrash`)
- `messages.get` → `{ message }` including optional attachment metadata (`id`, `filename`, `mimeType`, `size`) — not bytes
- `grants.sync` → inline Gmail history sync (`bootstrap` / `incremental` / `full`)

## Host env (few knobs)

See [`examples/host-integration/host.env.example`](../../examples/host-integration/host.env.example). Do **not** copy server `.env.example` into a host app — that file includes Postgres, vault, and Google OAuth for **InboxLink operators**, not hosts.

## Versioning

- **0.x** — public API may still change; treat minors as potentially breaking for host apps.
- Publish only via the manual GitHub Actions workflow (see [docs/publishing.md](../../docs/publishing.md)). No CI job publishes on every merge. **No live publish in this PR.**

## License

MIT — see [LICENSE](./LICENSE).
