# `@inboxlink/sdk`

Host-app HTTP client for [InboxLink](https://github.com/EtienneFokou-E18560/inboxlink).

Gmail-first surface: Connect sessions, grant exchange, **list / get messages**, and **history sync**. Do **not** ship `INBOXLINK_API_SECRET` to browsers. This package does **not** add Microsoft Graph or IMAP client APIs.

**Hosts never set `GOOGLE_*`.** Google OAuth lives on the InboxLink server (Production or your self-host). Production runs `INBOXLINK_MODE=multi`: host APIs need `Authorization: Bearer` via SDK `apiSecret` / `INBOXLINK_API_SECRET`. `GET /health` stays public.

## Install

```bash
npm install @inboxlink/sdk
```

Monorepo / git consumers can still use the workspace or a `file:` / git dependency. See [docs/publishing.md](../../docs/publishing.md) and [CHANGELOG.md](./CHANGELOG.md).

## Quick start (Production, multi mode)

```ts
import { InboxLink, InboxLinkApiError } from "@inboxlink/sdk";

// baseUrl defaults to https://inboxlink-two.vercel.app
// Production requires apiSecret (never expose this in a browser bundle)
const il = new InboxLink({
  apiSecret: process.env.INBOXLINK_API_SECRET,
});

const session = await il.createConnectSession({
  externalUserId: "user-1",
  redirectUri: "http://127.0.0.1:9999/done", // your host callback, not Google
});
// Redirect the end user to session.connectUrl

// On your redirect handler:
const { grantId } = await il.completeConnect({ redirectUrl: request.url });
const page = await il.messages.list(grantId, {
  limit: 20,
}); // synced store by default — see page.syncedAt / page.historyId
const live = await il.messages.list(grantId, {
  source: "live",
  q: "is:unread",
  label: "INBOX",
  from: "ada@example.com",
});
```

### Local / self-host overrides

```ts
// Local default is often INBOXLINK_MODE=single — omit apiSecret there.
// For a multi local/self-host, pass apiSecret like Production.
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
| Webhooks | `webhooks.verify` | local HMAC check for server-delivered events |

- `messages.list` → **synced store** by default (`source: "store"`); response may include `syncedAt` / `historyId` from the last sync cursor. Pass `source: "live"` for live Gmail list via `format=metadata` (headers/snippet/labels; optional filters: `q`, `from`, `to`, `subject`, `label`, `includeSpamTrash`)
- `messages.get` → `{ message }` with `format=full`, including optional `body` and attachment metadata (`id`, `filename`, `mimeType`, `size`) — not bytes
- `grants.sync` → inline Gmail history sync (`bootstrap` / `incremental` / `full`); bootstrap upserts without wiping prior cache

### Webhooks (verify delivered events)

When the InboxLink server has `INBOXLINK_WEBHOOK_URL` + `INBOXLINK_WEBHOOK_SECRET`, it POSTs signed JSON to your host for `grant.connected`, `grant.needs_reauth`, and `sync.completed`. Use the **raw request body** and the `X-InboxLink-Signature` header:

```ts
const rawBody = await request.text();
const ok = il.webhooks.verify({
  payload: rawBody,
  signatureHeader: request.headers.get("x-inboxlink-signature") ?? "",
  secret: process.env.INBOXLINK_WEBHOOK_SECRET!, // same value operators set on InboxLink
});
if (!ok) return new Response("invalid signature", { status: 401 });
const event = JSON.parse(rawBody) as { type: string; data: Record<string, unknown> };
```

See [docs/host-integration.md](../../docs/host-integration.md#host-webhooks-signed-events) for event payloads and retry behavior. `message.created` is not emitted yet.

## Host env (few knobs)

See [`examples/host-integration/host.env.example`](../../examples/host-integration/host.env.example). Do **not** copy server `.env.example` into a host app — that file includes Postgres, vault, and Google OAuth for **InboxLink operators**, not hosts.

## Versioning

- **0.x** — public API may still change; treat minors as potentially breaking for host apps.
- Publish only via the manual GitHub Actions workflow (see [docs/publishing.md](../../docs/publishing.md)). No CI job publishes on every merge. **No live publish in this PR.**

## License

MIT — see [LICENSE](./LICENSE).
