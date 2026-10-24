# `@inboxlink/sdk` changelog

## 0.3.0

Minor release for data minimisation (issue #86, part of askel#618). **Server behaviour changes for every tenant, read before upgrading:** the synced store (`messages.list` without `source: "live"`) now holds less, and `message.created` no longer carries the subject. Live reads are unchanged. The rules apply to new connections and new mail; messages cached before the server update are left as they were.

- **Inbox only (server).** The synced store keeps messages labelled `INBOX` and never `SENT`, `DRAFT`, `SPAM` or `TRASH`. Sent mail is never stored: read it with `messages.list(grantId, { source: "live", label: ["SENT"] })`. A stored message that leaves the inbox (archived, trashed) is removed at the next sync, and one restored from the trash or spam is stored again at the next sync (issue #101).
- **Metadata only (server).** Store reads return `id`, `grantId`, `providerMessageId`, `threadId`, `receivedAt`, `labels`, `folderIds`, `subject` and `snippet`. `from` and `to` are empty arrays, `sentAt` repeats `receivedAt`, `hasAttachments` is `false`, and there is no `body`. Use `messages.get` (live, unchanged) for the full message. The server encrypts the stored subject and snippet and reads Gmail with `format=metadata` when it syncs.
- **Time limit (server).** Stored messages received more than `INBOXLINK_MESSAGE_TTL_DAYS` days ago (30 on the hosted service) are deleted at each sync of the grant and by the daily `drain-sync-jobs` job. The first look skips mail older than that. Sync job results gain `expired` (`SyncResult.expired?: number`), the rows that sync deleted.
- **One first look per grant (server).** A grant's first sync looks back once (up to 50 inbox messages inside the time limit). After that, `grants.sync(grantId, { mode: "full" })` runs as an incremental sync, and a Gmail history watermark that expired restarts from the mailbox's current state instead of looking back again. Job `kind` still echoes what you asked for; `result.mode` says what ran.
- **`message.created` carries identifiers only (server).** `data` is `{ grantId, tenantId, externalUserId, provider, messageId, providerMessageId, threadId, receivedAt }`; `subject` is gone. New exported type `MessageCreatedEventData`. Call `messages.get` to read the message.
- No change to method signatures; `SyncOptions.mode` and `ListMessagesOptions.source` are documented with the new behaviour.

## 0.2.0

Minor release for the per-tenant Connect rule and grant clean-up (askel#604). Additive: a host on `0.1.3` keeps working, and a tenant keeps today's Connect rule unless its server sets `INBOXLINK_CONNECT_POLICY`. Two server changes reach every tenant: the new `grant.revoked` event (endpoints registered without an `events` list, and the `INBOXLINK_WEBHOOK_URL` fallback, start receiving it; ignore unknown event types to stay unaffected), and the narrower `needs_reauth` rule (last item).

- **Reconnect without losing the cache (server, opt-in per tenant).** With `INBOXLINK_CONNECT_POLICY=<tenant>=reuse`, a Gmail Connect of a mailbox the tenant already has a live grant for puts the fresh token on that grant. The mailbox is the address Gmail's own profile reports for the new token (`users.getProfile`), never the id-token address, so an account that merely claims another address cannot take over its grant; when the profile cannot be read, a new grant is made. Microsoft grants are never reused. Result: same `grantId`, cached messages kept, status back to `active`, owned by the user who just connected. Only an incremental sync is queued. A Connect of a different address adds a grant next to the existing ones, unless the session names the one it replaces (next item). Tenants not listed keep `replace` (a new grant; earlier grants for the address retired), as in 0.1.3.
- `link.createSession({ ..., replacesGrantId })`: the host user's own grant this Connect replaces, when you asked the person and they chose "replace". If they connect a different address, that grant is retired (`revoked`, `replaced: true`, token and cache deleted); the same address is reused (or replaced under `replace`). The server answers 400 `invalid_replaces_grant` for a grant that is not this user's live grant in your tenant. IMAP Connects honour it too (an IMAP grant is never reused). New field on `CreateLinkSessionInput` (core).
- `GrantOwnerOptions` (`{ externalUserId }`) on `messages.list`, `messages.iterate`, `messages.get`, `grants.sync`, `grants.getSyncJob` and `grants.revoke`: name the host user you believe owns the grant. When the grant now belongs to another of your users (reused for them), the call answers **409 `grant_replaced`** and does nothing, so a deleted or stale account cannot read or delete a mailbox that moved on. Without it, calls behave as before.
- `grants.listAll({ limit?, cursor? })` and `grants.iterateAll()`: every grant of your tenant, oldest first (`GET /v1/grants?all=true`, limit 1–200, default 50). Each `TenantGrant` has `id`, `externalUserId`, `provider`, `status`, `createdAt`, `updatedAt`, `lastSyncAt?` (end of the last finished sync) and `replaced?`. No address, no token. For finding grants whose host user no longer exists on your side.
- Webhook event **`grant.revoked`** (`GrantRevokedEventData`): `externalUserId` lost the mailbox in a Connect made by another of your users (a user replacing their own grant learns the new one from that Connect, so no event). `reason: "replaced"` (the grant was retired) or `"reassigned"` (the same grant now belongs to another of your users). Handle both like a 409 `grant_replaced`: ask that user to reconnect. Endpoints registered with an explicit `events` list must add it to receive it.
- **`needs_reauth` only when Google requires it (server).** A grant is marked `needs_reauth` only when Google refuses its refresh token (`invalid_grant`: revoked, expired, consent withdrawn), Gmail answers 401, or Gmail answers 403 naming a reason other than a rate limit or InboxLink's own setup (`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `quotaExceeded`, `backendError`, `accessNotConfigured`, `RESOURCE_EXHAUSTED`); a 403 that names no reason is temporary too. A refresh that fails for any other reason (Google 5xx, network, rate limit, a misconfigured client) leaves the grant `active`: reads answer **502 `gmail_unavailable`** and the next sync retries. Previously any refresh failure, and any Gmail 403, asked the person to reconnect. There is no time-based clean-up of `needs_reauth` grants.

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
