# `@inboxlink/sdk` changelog

## 0.1.3

Patch release, additive only: hosts on `0.1.2` keep working and simply ignore the new fields.

- `Message.headers?: { listUnsubscribe?, precedence?, autoSubmitted? }` (new exported type `MessageHeaders`): on every message of `messages.list(grantId, { source: "live" })` the server returns the raw `List-Unsubscribe`, `Precedence` and `Auto-Submitted` values. A field is absent when the message has no such header, and `headers` is absent when it has none of the three. Read in the same Gmail `messages.get` (`format=metadata`) call the live list already makes per message: no new scope, no body read. Not filled on the store list (`source: "store"`, the default) or on `messages.get`.
- `Message.labels` is documented as Gmail's `labelIds` exactly as Gmail returns them (`INBOX`, `UNREAD`, `CATEGORY_PROMOTIONS`, user labels by id), on live and store reads; `folderIds` is the folder-like subset (`INBOX`, `SENT`, `TRASH`, `SPAM`, ... and every `CATEGORY_*`). No behaviour change: both were already filled.
- Servers that include the one-live-grant-per-mailbox rule answer **409 `grant_replaced`** on `messages.list`, `messages.get` and `grants.sync` for a grant that was retired because the same address was connected again (by the same or another `externalUserId`). Treat it like `grant_inactive`: stop polling and offer to reconnect. `grants.list` returns such a grant as `status: "revoked"` with an extra `replaced: true`. The id of the grant that replaced it is never returned. The error surfaces as the usual `InboxLinkApiError` with `status: 409` and `code: "grant_replaced"`.
- `Grant` (as returned by `grants.list`) gains `replaced?: boolean`, typed for the flag above. Additive, no breaking change.

## 0.1.2

Release notes for hosts upgrading from `0.1.1`. **Hosts that call `messages.list` with `q` / `label` should upgrade: with servers that include the store-backed list (Wave B) the filters are applied only when `source: "live"`, and `0.1.1` has no way to ask for it.** A host on `0.1.1` silently gets the unfiltered synced cache.

### Server-side fix, no SDK change

`snippet` is now returned as plain text. Gmail returns it HTML-escaped (`We&#39;re`); the Gmail adapter decodes it. Message bodies are decoded with the charset each MIME part declares (ISO-8859-1, Windows-1252, ...) instead of always as UTF-8.

### Async sync jobs (Wave D)

`grants.sync` returns `202` `{ jobId, status: "queued" }`. Poll
`grants.getSyncJob(grantId, jobId)` for `completed` / `failed`. Server emits
`sync.completed` and (on Gmail push) `message.created`.

### Host webhook verify docs

Documented server-delivered events (`grant.connected`, `grant.needs_reauth`,
`sync.completed`, `message.created`) and how to use `webhooks.verify` against
`X-InboxLink-Signature`. Delivery is configured on the InboxLink server via
`INBOXLINK_WEBHOOK_URL` + `INBOXLINK_WEBHOOK_SECRET`.

### Store-backed list + `source=live`

Default `messages.list` reads the synced store cache. Pass `source: "live"` for
live Gmail list + filters. Store responses may include `syncedAt` / `historyId`.

## 0.1.1

Release notes for hosts upgrading from `0.1.0`.

### Message list filters

`messages.list` / `messages.iterate` now forward Gmail list filters to
`GET /v1/grants/:id/messages` (requires a Production / self-host that includes #35).
**With Wave B servers, filters apply only when `source: "live"`.**

| Option | Behavior |
|--------|----------|
| `source` | `"store"` (default) or `"live"` |
| `q` | Gmail search query (e.g. `is:unread newer_than:7d`) — live only |
| `from` / `to` / `subject` | Structured header matchers (AND-merged into `q`) — live only |
| `label` | Gmail label id(s) → `labelIds` (string or string[]) — live only |
| `includeSpamTrash` | Include SPAM/TRASH in results — live only |

### Other notes since 0.1.0

- No breaking changes to existing Connect / grants / get / sync method signatures.
- Server-side host redirect allowlisting (#24) may reject unknown `redirectUri` values when operators configure an allowlist — unrelated to this package’s API surface, but visible to hosts on Production.
- Publish path unchanged: Actions → **Publish npm packages** (`publish-npm.yml`, `workflow_dispatch`). Public GitHub source enables npm provenance on this release.

## 0.1.0

Initial public npm release: Connect helpers, grants, message list/get, history sync, and Production defaults for single-mode hosts.
