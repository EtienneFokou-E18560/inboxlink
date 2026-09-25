# InboxLink ops runbook (Vercel + health)

Short guide for Production at `https://inboxlink-two.vercel.app`. No paid APM required — use Vercel function logs (structured JSON lines) and the smoke script below.

**Never** paste refresh tokens, Bearer secrets, `public_token`, `link_token`, or `DATABASE_URL` into git, PRs, Slack, or this doc.

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
  "queue": "disabled",
  "store": "postgres"
}
```

`GET /health` is public (no Bearer). Host APIs (`/v1/link/sessions`, grants, messages) require `Authorization: Bearer <INBOXLINK_API_SECRET>`.

Optional alert (no new SaaS): cron or GitHub Action that runs `scripts/smoke-health.sh` against Production and pages you on non-zero exit. Vercel’s own failure emails cover function crashes.

## Structured logs

The server writes one JSON object per line (`ts`, `level`, `service`, `event`, …). Sensitive keys and token-shaped values are replaced with `[REDACTED]` before emit.

On Vercel: Project → Deployments → Functions → Logs. Filter by `event` (examples: `http_request`, `oauth_callback_failed`, `grant_needs_reauth`, `server_listening`).

Local:

```bash
pnpm --filter @inboxlink/server dev
# watch stdout for JSON lines
```

## `needs_reauth`

When Gmail refresh fails or list returns 401/403, the grant is marked `needs_reauth` and messages return:

```json
{
  "error": "needs_reauth",
  "guidance": "Refresh token rejected or Gmail returned 401/403. Start a new Connect session for this user; the previous grant is marked needs_reauth."
}
```

**Fix:** create a new link session and complete Connect again (same `externalUserId` is fine). Do not reuse an old `public_token`. List grants should show `status: "needs_reauth"` until a new grant replaces it or you revoke.

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

## OAuth callback failures

Browser HTML pages (not JSON) on `/v1/oauth/gmail/callback`:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Invalid or expired link | Session past `expiresAt` | Create a new session; complete Google promptly |
| `invalid_client` | Bad `GOOGLE_CLIENT_*` | Replace web client id/secret in Vercel, redeploy |
| `redirect_uri_mismatch` | Console URI ≠ env | Set exact `GOOGLE_REDIRECT_URI` in Google + Vercel |
| `invalid_grant` | Code reused/expired | Restart Connect |
| Could not store refresh token | Short/missing master key | Set `INBOXLINK_MASTER_KEY` (≥16 chars), redeploy |
| Unknown OAuth state | Memory store / wrong instance | Require `store: postgres` before Connect |

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
