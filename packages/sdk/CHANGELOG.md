# `@inboxlink/sdk` changelog

## Unreleased

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
