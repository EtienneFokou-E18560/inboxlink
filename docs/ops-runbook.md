# InboxLink ops runbook (Vercel + health)

Short guide for Production at `https://inboxlink-two.vercel.app`. No paid APM required — use Vercel function logs (structured JSON lines) and the smoke script below.

**Never** paste refresh tokens, Bearer secrets, `public_token`, `link_token`, or `DATABASE_URL` into git, PRs, Slack, or this doc.

## Security posture (quick)

| Control | Behavior |
|---------|----------|
| **PKCE (S256)** | Connect issues `code_verifier` / `code_challenge`; Google token exchange sends the verifier. `oauth_state` is **consumed atomically** on first callback use (replay → unknown state). |
| **Refresh fail-closed** | Missing / rejected refresh → grant `needs_reauth`; no silent “half grant”. |
| **Access-token cache** | In-process short-lived access tokens only (see below). Refresh tokens never cached. |
| **Schema dump** | `GET /v1/schema.sql` requires Bearer in `multi` (Production) — not world-readable. |
| **HTML headers** | Connect / landing / status / docs send CSP + `X-Content-Type-Options` + `X-Frame-Options` + `Referrer-Policy`. |
| **Health smoke** | [production-health-smoke.yml](../.github/workflows/production-health-smoke.yml) + `scripts/smoke-health.sh` (expect `store: "postgres"`). |
| **Dependencies** | No Dependabot version-update PRs. [dependency-report.yml](../.github/workflows/dependency-report.yml) writes a weekly read-only summary (`pnpm outdated`, `pnpm audit --prod`); updates are made by hand. Dependabot alerts (repo setting) still email the maintainer. |

## Health clarity

```bash
BASE=https://inboxlink-two.vercel.app
./scripts/smoke-health.sh "$BASE"
# Local memory store:
# ./scripts/smoke-health.sh http://localhost:8787 --allow-memory
```

| `GET /`, `/health`, `/health/` | Meaning | Action |
|--------------------------------|---------|--------|
| `200`, `ok: true`, `store: "postgres"` | Production-ready shared store | Safe to Connect |
| `200`, `ok: true`, `store: "memory"`, `warning: "ephemeral_store"` | Process memory only | **Do not** Connect on Vercel. Set `DATABASE_URL`, redeploy, re-smoke |
| `503`, `ok: false`, `error: "database_unavailable"` | Postgres unreachable | Fix Neon/`DATABASE_URL`; see `guidance` in the JSON body |

Healthy Production shape:

```json
{
  "ok": true,
  "service": "inboxlink",
  "mode": "multi",
  "queue": "jobs",
  "store": "postgres"
}
```

`queue: "jobs"` means the durable Postgres `sync_jobs` path is wired (Wave D2). Redis is unused.
`GET /health` is public (no Bearer). Host APIs (`/v1/link/sessions`, grants, messages, **`/v1/schema.sql`**) require `Authorization: Bearer <INBOXLINK_API_SECRET>` in `multi`.

**Automated smoke:** GitHub Actions workflow [`.github/workflows/production-health-smoke.yml`](../.github/workflows/production-health-smoke.yml) runs `scripts/smoke-health.sh` on a 6-hour schedule and via **Actions → Production health smoke → Run workflow**. It fails the job if `ok` is not `true` or `store` is not `postgres`. Optional repo variable `INBOXLINK_PRODUCTION_URL` overrides the default Production base URL; do not store Production secrets in git or workflow files (health is public). GitHub emails on workflow failure; Vercel’s own emails cover function crashes.

## Structured logs

The server writes one JSON object per line (`ts`, `level`, `service`, `event`, …). Sensitive keys and token-shaped values are replaced with `[REDACTED]` before emit.

On Vercel: Project → Deployments → Functions → Logs. Filter by `event` (examples: `http_request`, `oauth_callback_failed`, `grant_needs_reauth`, `server_listening`).

Local:

```bash
pnpm --filter @inboxlink/server dev
# watch stdout for JSON lines
```

## `needs_reauth`

A grant is marked `needs_reauth` only when Google requires the person to connect again: the refresh is refused with `invalid_grant` (token revoked or expired, consent withdrawn), Gmail answers 401, or Gmail answers 403 naming a reason other than a rate limit or our own setup (`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `quotaExceeded`, `backendError`, `accessNotConfigured`, `RESOURCE_EXHAUSTED`; a 403 with no reason is temporary too). A status write from a request that loaded the grant before a reconnect reused it is skipped (it only writes over the version it read). Messages then return:

```json
{
  "error": "needs_reauth",
  "guidance": "Google refused this grant's token (revoked, expired, or access withdrawn). Start a new Connect session for this user; the previous grant is marked needs_reauth."
}
```

Any other refresh failure (Google 5xx, the network, a 429, `invalid_client` from our own configuration) leaves the grant `active`: reads answer 502 `gmail_unavailable`, syncs end `gmail_unavailable`, the watch renewal counts it as `watch_failed`, and the next call tries again. Log event `gmail_unavailable` (`reason: "refresh_failed"`).

**Fix:** create a new link session and complete Connect again (same `externalUserId` is fine). Do not reuse an old `public_token`. List grants show `status: "needs_reauth"` until a new Connect settles it (next section) or you revoke. There is no time-based clean-up: a `needs_reauth` grant keeps its token and cache until the person reconnects or the host deletes it (for example with the account).

## `grant_replaced` (one live grant per mailbox)

The Connect rule is per tenant: `INBOXLINK_CONNECT_POLICY` (`askel=reuse`, comma or space separated; an invalid entry stops the server at boot). Tenants not listed keep `replace`, described next. Under `reuse`, a Gmail Connect of a mailbox the tenant already has a live grant for (matched on the address `users.getProfile` reports for the new token; log `connect_profile_failed` and a new grant, retiring nothing, when it cannot be read; Microsoft is never reused) seals the fresh token on that grant (one conditional `UPDATE ... RETURNING` that only takes a live row; the grant keeps its id and cache and moves to the connecting `externalUserId`), retires the tenant's other live grants for the address, and queues an incremental sync. Log events `grant_reused` (`grantId`, `tenantId`, `sameUser`, `retired`) and `grant_replaced`. If the claim loses a race with a retirement, the token it sealed is destroyed and a new grant is made. A session may name `replacesGrantId` (the same user's grant); when the connected address differs, that grant is retired too. Every retirement and every move to another user sends `grant.revoked` to the host.


A finished Connect retires the tenant's `active` / `needs_reauth` grants for the same provider and address (case ignored) that were created before it (ties broken on grant id), whichever `externalUserId` owned them: token and cached messages deleted, status `revoked`, `replaced_by` set to the new grant id. Reads and syncs on the old id answer 409 `grant_replaced`; `GET /v1/grants` shows it `revoked` with `replaced: true`. Log event: `grant_replaced` (`grantId`, `replacedBy`, `tenantId`, `sameUser`; never the address). The old refresh token is not revoked at Google, because that would also end the new one.

Races it is safe against: the retire step is one conditional `UPDATE ... RETURNING`, and only the grants it returned lose their token and cache, so a slow Connect finishing after a newer one never retires the newer grant. Status writes never touch a `revoked` row (a 401 in a sync that was running during the retirement does not turn it back into `needs_reauth` or clear `replaced_by`), and the message upsert only writes for `active` grants.

Grants created before this rule are **not** cleaned up by a deploy. Find them with the read-only report:

```bash
psql "$DATABASE_URL" -f scripts/shared-address-report.sql
```

The first table counts, per tenant, addresses with more than one grant and those with more than one live grant (the ones to act on). The second lists the live grants on those addresses (grant id, an 8-character address key, identity kind `anonymous` / `google` / `account`, status, date, cached messages); no address is printed. The next Connect of that mailbox keeps only the newest grant. To clean up sooner, revoke the grants you don't want with `DELETE /v1/grants/:id` (or `il.grants.revoke`) using that tenant's secret; that is a manual owner decision, nothing does it automatically.

## Grant health report

Read-only counts of grants per tenant by status and age, and of live grants by kind of host user (`anonymous` / `google` / `account`) and time since the last finished sync. No address, grant id or user id is printed. Run it before and after a change to grant handling:

```bash
psql "$DATABASE_URL" -f scripts/grant-health-report.sql
```

A host can list its own tenant's grants (ids, owner ids, status, dates, last finished sync; no addresses) with `GET /v1/grants?all=true` and its tenant secret.

## Access-token cache

Message list/get/sync open the vault and call Google’s token endpoint only on a **cache miss**. Short-lived access tokens are kept in an **in-process Map keyed by grant id** (shared by routes + sync inside one Node / Vercel isolate).

| Limit | Behavior |
|-------|----------|
| Scope | Per isolate only — not Redis, not Postgres, not shared across Vercel instances |
| Cold start | Always miss (empty Map after a new function instance boots) |
| TTL | Google `expires_in` minus 60s skew; if omitted, ~50 minutes |
| Invalidate | Grant delete, refresh failure, Gmail 401/403 |
| Secrets | **Access** tokens only — refresh tokens never enter this cache |

Expect fewer Google refresh RTTs on warm paths; do not rely on the cache for durability or cross-instance coherence.

## Host webhooks (Wave C)

When **both** `INBOXLINK_WEBHOOK_URL` and `INBOXLINK_WEBHOOK_SECRET` are set, the server POSTs signed events to the host callback:

| Event | Emit point |
|-------|------------|
| `grant.connected` | OAuth callback success |
| `grant.needs_reauth` | Google refused the token: refresh `invalid_grant`, Gmail 401, or a non-rate-limit 403 (reads, sync, push) |
| `grant.revoked` | A Connect retired a grant (`reason: "replaced"`) or moved a reused grant to another host user (`"reassigned"`); `externalUserId` is the user who lost it |
| `sync.completed` | Successful sync job (API drain, push apply, or cron) |
| `message.created` | New inbox message upserted via Gmail Pub/Sub push apply (identifiers only, no subject) |

Retries: 408 / 429 / 5xx (bounded). Hard 4xx → drop. Delivery failures are logged (`webhook_delivery_*`) and **never** fail Connect redirects or sync HTTP responses.

Unset either env → no outbound POSTs (hosts can still poll). See [host-integration.md](./host-integration.md#host-webhooks-signed-events).

## Gmail push (Pub/Sub) + watch renewal (Wave D1)

Optional. When unset, hosts rely on `POST /v1/grants/:id/sync` (poll) — that path remains supported.

| Env | Purpose |
|-----|---------|
| `GMAIL_PUBSUB_TOPIC` | Full topic name `projects/PROJECT/topics/TOPIC` |
| `GMAIL_PUSH_SECRET` | Shared secret for push endpoint (`?token=` or `X-InboxLink-Push-Secret`) |
| `CRON_SECRET` | Bearer for `/v1/internal/cron/*` (Vercel Cron + GitHub Action) |

**GCP setup (no secrets in git):**

1. Create a Pub/Sub topic in the same GCP project as the Gmail OAuth client.
2. Grant **Pub/Sub Publisher** on that topic to `gmail-api-push@system.gserviceaccount.com`.
3. Create a **push** subscription whose endpoint is  
   `https://<your-host>/v1/internal/gmail/push?token=<GMAIL_PUSH_SECRET>`.
4. Set `GMAIL_PUBSUB_TOPIC` + `GMAIL_PUSH_SECRET` + `CRON_SECRET` in Vercel; redeploy.

On Connect, InboxLink calls Gmail `users.watch` (best-effort). Watches expire within **≤7 days**; renew **daily**.

| Route | Auth | Role |
|-------|------|------|
| `POST /v1/internal/gmail/push` | `GMAIL_PUSH_SECRET` | Decode Pub/Sub → `history.list` from cursor → upsert/delete → webhooks |
| `GET\|POST /v1/internal/cron/renew-gmail-watches` | `CRON_SECRET` Bearer | Renew watches for all active Gmail grants |
| `GET\|POST /v1/internal/cron/drain-sync-jobs` | `CRON_SECRET` Bearer | Delete stored messages past `INBOXLINK_MESSAGE_TTL_DAYS` (all grants; response `expiredMessages`, log `messages_expired`), then process queued `sync_jobs` |

Vercel `vercel.json` schedules **daily** drain (`0 7 * * *`) and renew (`0 6 * * *`) — Hobby plans reject sub-daily cron expressions (deployment fails). Frequent drain uses [`.github/workflows/wave-d-cron.yml`](../.github/workflows/wave-d-cron.yml) (every 15 minutes; needs secrets `INBOXLINK_CRON_BASE_URL` + `CRON_SECRET`). A best-effort deferred drain also runs after `POST …/sync` enqueue.

**Fallback:** If push is silent, history returns **404**, or watch expired → `syncGmailGrant` recovers without crashing: a grant that never had its first look bootstraps; one that had it moves its cursor to the mailbox's current `historyId` and reads new mail from there (no second look back, issue #86). Hosts can always `POST …/sync` (poll).

## Message store rules (issue #86)

| Rule | Where it is enforced |
|------|----------------------|
| Inbox only (`INBOX`, never `SENT`/`DRAFT`/`SPAM`/`TRASH`) | First look lists `labelIds=INBOX`; incremental skips history adds outside the inbox and removes a stored message that left it |
| No bodies, no addresses | Sync reads `format=metadata`; the store writes `payload = NULL`, plain `subject`/`snippet` = `''` |
| Subject and snippet encrypted | `messages.subject_ct` / `snippet_ct`: AES-256-GCM, key = HKDF-SHA256(`INBOXLINK_MASTER_KEY`, label `inboxlink/message-metadata/v1`), additional data = field + grant id + Gmail message id. Rotating the master key makes these unreadable (list shows them empty, log `message_metadata_unreadable` with a count only); the next first look cannot refill them, they age out within the time limit |
| Time limit | `INBOXLINK_MESSAGE_TTL_DAYS` (unset or invalid = 30). Delete at the start of each grant sync and in `drain-sync-jobs` (daily Vercel cron and the 15-minute GitHub Action). Partial index `messages_minimised_received_idx` serves it |
| Startup DDL locks | `PgDatabase.migrate` reads `information_schema.columns` and `pg_indexes` once and skips every `ALTER TABLE` / `CREATE INDEX` already in effect, so a normal cold start takes no ACCESS EXCLUSIVE or SHARE lock; only the first start after an upgrade does. Two cold starts racing on `CREATE INDEX IF NOT EXISTS` can fail on `pg_class_relname_nsp_index`; that error counts as "already exists". No `lock_timeout` is set (a session `SET` would leak through a transaction pooler) |
| Message key per grant (issue #100) | `messages` is keyed on `(grant_id, id)` (`messages_grant_pkey`), not `id`: two grants for one mailbox share Gmail ids. On a database from before, the first start builds the unique index `messages_grant_pkey` (SHARE lock: reads continue, writes wait for the build) and then swaps the key in one `ALTER TABLE ... DROP CONSTRAINT IF EXISTS messages_pkey, ADD CONSTRAINT messages_grant_pkey PRIMARY KEY USING INDEX` (brief ACCESS EXCLUSIVE; no table rewrite), run with `SET LOCAL lock_timeout = '3s'` (issue #103): if running queries hold the table longer, the start keeps the old key, logs `schema_key_swap_deferred` and the next cold start tries again (writes keep working through the unique index meanwhile). Both are skipped once `pg_constraint` shows `messages_grant_pkey` as the key. A racing start that loses gets SQLSTATE `55000` (index already associated with a constraint) or `42P16` (table already has a primary key); matched by code, not message text, and counted as done only when a fresh read of `pg_constraint` shows `messages_grant_pkey` as the key. A primary key under any other name fails the start with `42P16` rather than being left unswapped. Ids and rows are unchanged. A sync that fails on a store call ends `store_unavailable` (log `sync_store_failed` with `step` and Postgres `code`), never `gmail_unavailable`, including the steps before Gmail is read: `delete_expired_messages`, `read_vault`, `get_sync_cursor` (issue #103) |
| Label changes | A history event fetches a message only if it adds `INBOX` or the message is already stored; starring sent mail or reading archived mail fetches nothing |
| Restore from trash or spam (issue #101) | Removing `TRASH` or `SPAM` counts like adding `INBOX`: the message is fetched and stored if its labels now pass the inbox rule (Gmail may keep `INBOX` on trashed mail, so the restore event only removes `TRASH`) |
| One first look | `sync_cursors.first_look_at`, set by the bootstrap; `mode: "full"` is ignored once set. Cursors that existed when the column was added count as done |
| Rows from before #86 | Owner decision 23 Oct: untouched. A row with a `payload` is never overwritten, never removed by the inbox or time-limit rules (only by a Gmail delete, a revoke or a replace, as before). No clean-up script |

Read-only check, no content: `SELECT count(*) FILTER (WHERE payload IS NULL) AS minimised, count(*) FILTER (WHERE payload IS NOT NULL) AS before_86, min(received_at) FILTER (WHERE payload IS NULL) AS oldest_minimised FROM messages;` (also in `scripts/usage-report.sql`).

## Async sync jobs (Wave D2)

`POST /v1/grants/:id/sync` returns **202** + `{ jobId, status: "queued" }` (no longer waits for Gmail inline). Poll:

```http
GET /v1/grants/:id/sync/jobs/:jobId
Authorization: Bearer <INBOXLINK_API_SECRET>
```

Jobs live in Postgres `sync_jobs` (MIT-only; Redis/BullMQ unused). Cron/`drain-sync-jobs` executes them and emits `sync.completed` / `grant.needs_reauth`. A best-effort deferred drain also runs after enqueue (may be cut short on cold serverless — cron is authoritative).

## Gmail 429 and sync timeouts

`POST /v1/grants/:grantId/sync` enqueues a job; Gmail work runs in cron drain / deferred invoke. Message list/get still talk to Google from the Vercel function. Typical failure modes:

| Symptom | Likely cause | Mitigation |
|---------|--------------|------------|
| `502` `gmail_unavailable` with Gmail status **429** | Google quota / user-rate limit | Back off; reduce concurrent sync/list; retry later. Logs: `gmail_unavailable` + `gmailStatus: 429`. |
| Job stuck `queued` | Cron not configured / `CRON_SECRET` mismatch | Set `CRON_SECRET`; confirm Vercel Cron or Actions hits drain route |
| Function **timeout** during push/drain | Large mailbox / slow Gmail RTT vs Vercel `maxDuration` | `api/index.ts` / `vercel.json` set `maxDuration: 60`. Prefer incremental after bootstrap. |
| Empty / stale list after Connect | Host listed before sync job completed, or expected live Gmail | Default `GET …/messages` is **store**; poll job status or wait for `sync.completed`, or use `?source=live`. |
| Cold start + cache miss stampede | New isolate empty access-token cache | Expected; tokens re-refresh. Not a durability bug. |

Do **not** raise Google quotas by embedding Production secrets in CI or this doc. If 429s persist under normal host load, investigate per-grant polling frequency on the host side first.

## OAuth callback failures

Browser HTML pages (not JSON) on `/v1/oauth/gmail/callback`:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Invalid or expired link | Session past `expiresAt` | Create a new session; complete Google promptly |
| `invalid_client` | Bad `GOOGLE_CLIENT_*` | Replace web client id/secret in Vercel, redeploy |
| `redirect_uri_mismatch` | Console URI ≠ env | Set exact `GOOGLE_REDIRECT_URI` in Google + Vercel |
| `invalid_grant` | Code reused/expired | Restart Connect |
| Google did not return a refresh token | Offline token omitted (repeat auth / skipped consent) | New connect link; approve Google access again (re-consent) |
| Could not store refresh token | Short/missing master key | Set `INBOXLINK_MASTER_KEY` (≥16 chars), redeploy |
| Unknown OAuth state | Memory store / wrong instance / **state replay** | Require `store: postgres` before Connect; state is one-shot |

Logs: look for `oauth_callback_failed` with a redacted `reason` code (never the authorization `code`).

## Deploy smoke checklist

1. CI green on the deploy SHA.
2. `./scripts/smoke-health.sh https://inboxlink-two.vercel.app` → OK.
3. Messages route exists: `GET /v1/grants/grant_does_not_exist/messages` → JSON `not_found` (not HTML 404).
4. Only then run Connect. Keep session tokens in private notes only — never in git.

Full timed proof steps live in the project plan `proof-deployment-4h.md` (agent store), not in this repo.

## Host redirect allowlist + CORS

Unset `ALLOWED_REDIRECT_ORIGINS` keeps Connect host redirects permissive (any http(s) URL) — fine while iterating host callbacks. Browser CORS still never uses `*`: only `PUBLIC_BASE_URL`’s origin is reflected until you set the allowlist.

To reduce open-redirect of `public_token` and align CORS with known host origins:

```bash
# Vercel env (Production)
ALLOWED_REDIRECT_ORIGINS=https://your-host.example,http://127.0.0.1:9999
```

Session create then rejects non-matching origins with `redirectUri_not_allowed`. Invalid env entries fail boot closed. Soft rate limits (`INBOXLINK_RATE_LIMIT_*`) apply in `single` and `multi` (in-process per isolate).

## Rollback triggers

- Health `store: "memory"` or `database_unavailable` after deploy → restore `DATABASE_URL` / roll back deployment; skip Connect.
- Widespread 5xx → roll Vercel Production to last known-good; keep env intact.
- Rolling back past issue #86 is safe for the data: the added columns stay, older code skips metadata-only rows (`payload IS NULL`) on the store list and overwrites them with full rows on its next sync. Nothing needs undoing in the database.


## Who is using it

npm download counts include CI installs, mirrors and bots, so they do not show real use. Real use shows up on the server. Run the read-only report against the Production database (`DATABASE_URL` stays in your shell, never in git or chat):

```bash
psql "$DATABASE_URL" -f scripts/usage-report.sql
```

For mailboxes connected more than once, see `scripts/shared-address-report.sql` under `grant_replaced` above.

It lists, per host app (tenant): active and total connected mailboxes, distinct users, first and latest connect, syncs in the last 7 days and the last sync, plus daily syncs and weekly new grants. It reads counts only, never message content or tokens. It cannot see self-hosted installs.
