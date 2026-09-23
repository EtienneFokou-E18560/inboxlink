# `@inboxlink/sdk`

Host-app HTTP client for [InboxLink](https://github.com/EtienneFokou-E18560/inboxlink).

Gmail-first surface: Connect sessions, grant exchange, **list / get messages**, and **history sync**. Do **not** ship `INBOXLINK_API_SECRET` to browsers. This package does **not** add Microsoft Graph or IMAP client APIs.

## Install

```bash
# From the monorepo (workspace):
pnpm add @inboxlink/sdk --filter your-app

# After a public npm release (not done until a maintainer runs the publish workflow):
npm install @inboxlink/sdk
```

Until the first npm publish, consume the package from this repository via the pnpm workspace or a git dependency.

## Quick start

```ts
import { InboxLink, InboxLinkApiError } from "@inboxlink/sdk";

const il = new InboxLink({
  baseUrl: process.env.INBOXLINK_BASE_URL ?? "http://localhost:8787",
  apiSecret: process.env.INBOXLINK_API_SECRET!,
});

const session = await il.link.createSession({
  externalUserId: "user-1",
  redirectUri: "https://your-app.example/oauth-done",
});
// Redirect the end user to session.connectUrl

const { grantId } = await il.grants.exchange({ publicToken });
const page = await il.messages.list(grantId, { limit: 20 });
const { message } = await il.messages.get(grantId, page.messages[0]!.id);
await il.grants.sync(grantId); // Gmail history watermark sync
```

## Client surface (v0.1, Gmail)

| Area | Methods | HTTP |
|------|---------|------|
| Link | `link.createSession` | `POST /v1/link/sessions` |
| Grants | `grants.exchange`, `grants.list`, `grants.revoke`, `grants.sync` | `/v1/grants…` |
| Messages | `messages.list`, `messages.get`, `messages.iterate` | `/v1/grants/:id/messages…` |
| Webhooks | `webhooks.verify` | local HMAC check |

- `messages.list` → live Gmail list
- `messages.get` → `{ message }` including optional attachment metadata (`id`, `filename`, `mimeType`, `size`) — not bytes
- `grants.sync` → inline Gmail history sync (`bootstrap` / `incremental` / `full`)

## Versioning

- **0.x** — public API may still change; treat minors as potentially breaking for host apps.
- Publish only via the manual GitHub Actions workflow (see [docs/publishing.md](../../docs/publishing.md)). No CI job publishes on every merge. **No live publish in this PR.**

## License

MIT — see [LICENSE](./LICENSE).
