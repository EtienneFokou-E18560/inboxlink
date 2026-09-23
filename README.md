# InboxLink

**Open-source “Plaid for email mailboxes.”**

InboxLink is standalone **mailbox connection infrastructure**: Link-style Connect, vaulted OAuth tokens, and a normalized messages API so host apps never hold Gmail refresh tokens.

It does **not** depend on [career-workspace](https://github.com/EtienneFokou-E18560/career-workspace). That app may become a later *consumer* via `@inboxlink/sdk` — never the other way around.

## Status (v0)

Working TypeScript monorepo with:

- Gmail OAuth **authorization URL + callback** (real Google token exchange when `GOOGLE_CLIENT_*` are set; placeholder credentials use a stub exchange)
- Encrypted **token vault** (AES-256-GCM; revoke deletes the ciphertext)
- HTTP API: link sessions, Connect stub, grants exchange/list/revoke, message list/get, health
- Postgres store when `DATABASE_URL` is set (auto-migrates schema + `default` tenant on startup)
- Optional Redis/BullMQ **queue placeholder**

`GET /v1/grants/:grantId/messages` lists Gmail messages for an active grant (live Gmail). `GET /v1/grants/:grantId/messages/:messageId` returns one message (InboxLink `msg_…` id or Gmail id) including attachment **metadata** (id, filename, mimeType, size) — not attachment bytes. `POST /v1/grants/:grantId/sync` runs **inline** history sync: bootstrap via `messages.list` + profile `historyId`, then incremental `users.history.list` with a persisted watermark in `sync_cursors` and idempotent message upserts. Redis is not required. CI uses a local Gmail HTTP stand-in and does not call Google. Microsoft/IMAP and npm publish are not implemented.

Production: [https://inboxlink-two.vercel.app](https://inboxlink-two.vercel.app) — expect `GET /health` → `"store":"postgres"` before any live Connect.

## Architecture overview

```text
Host app                         InboxLink                         Provider
────────                         ─────────                         ────────
SDK / curl
  │  POST /v1/link/sessions
  │◄──── sessionId, connectUrl
  │
User browser ──► GET /v1/connect/:linkToken (stub HTML)
                      │
                      ▼
                 Gmail OAuth ──────────────────────────► Google
                      │  callback + code
                      ▼
                 Vault seals refresh token
                 Store saves grant (memory or Postgres)
                      │
Host ── POST /v1/grants/exchange (one-time public_token) ──► grantId
Host ── GET  /v1/grants/:id/messages ── open vault → refresh → Gmail list
Host ── DELETE /v1/grants/:id ── destroy vault ciphertext + grant
```

| Layer | Location | Role |
|-------|----------|------|
| HTTP API | `@inboxlink/server` (Hono) | Sessions, OAuth callback, grants, messages, health |
| Core | `@inboxlink/core` | Types, vault crypto helpers, adapter interfaces |
| Gmail adapter | `@inboxlink/adapters-gmail` | Auth URL, token exchange/refresh, list + normalize |
| Store | memory or Postgres (`DATABASE_URL`) | Sessions, grants, vault ciphertext |
| Connect UI | stub HTML in server; `packages/connect-ui` placeholder | Browser Connect page |
| SDK | `@inboxlink/sdk` | Thin host HTTP client (not published to npm yet) |
| Deploy | `api/index.ts` + `vercel.json` | Vercel serverless entry wrapping the Hono app |

**Standing rules:** no Production secrets in git; MIT only; no career-workspace imports, shared DB, or shared types.

## Packages

| Package | Role |
|---------|------|
| `@inboxlink/core` | Types, vault crypto helpers, adapter interfaces |
| `@inboxlink/adapters-gmail` | Gmail OAuth + message list/normalize |
| `@inboxlink/sdk` | Host-app HTTP client |
| `@inboxlink/server` | Hono HTTP service |
| `@inboxlink/connect-ui` | Hosted Connect pages (pending CTA, expiry, OAuth errors) |
| `@inboxlink/demo` | Tiny SDK demo (`apps/demo`) |

## Requirements

- Node.js **22+**
- [pnpm](https://pnpm.io/) 9+
- Optional: Docker (Postgres / Redis via Compose)

## Quick start

```bash
git clone https://github.com/EtienneFokou-E18560/inboxlink.git
cd inboxlink
cp .env.example .env
pnpm install
pnpm build
pnpm --filter @inboxlink/server dev
```

Health check: [http://localhost:8787/health](http://localhost:8787/health). `GET /` and `GET /health/` return the same JSON. When the store is not Postgres, the body includes `warning: "ephemeral_store"` and operator `guidance`.

Ops: structured JSON logs (secrets redacted), [docs/ops-runbook.md](docs/ops-runbook.md), and `pnpm smoke:health -- <base-url>` (requires `store: "postgres"` unless you pass `--allow-memory`).

### Local Postgres (Compose)

For durable sessions/grants/vault (recommended once you leave the in-memory smoke path):

```bash
docker compose up -d
# .env.example already points DATABASE_URL at Compose Postgres:
# postgres://inboxlink:inboxlink@localhost:5432/inboxlink
pnpm --filter @inboxlink/server dev
curl -sS http://localhost:8787/health
# Expect: "store":"postgres"
```

The server applies schema on startup. Optional manual dump:

```bash
curl -sS http://localhost:8787/v1/schema.sql | psql "$DATABASE_URL"
```

Redis (`REDIS_URL`) is optional; leave unset so health reports `"queue":"disabled"`.

### Env checklist (names only)

Never commit real values. Set placeholders in `.env` locally and secrets only in Vercel / your secret store.

| Name | Required? | Notes |
|------|-----------|--------|
| `DATABASE_URL` | **Yes (Production / multi-instance)** | Shared Postgres. Unset → in-memory store (`"store":"memory"`). |
| `INBOXLINK_MASTER_KEY` | **Yes** for real vault | ≥16 characters |
| `PUBLIC_BASE_URL` | **Yes** | Local: `http://localhost:8787`. Prod: `https://inboxlink-two.vercel.app` |
| `GOOGLE_CLIENT_ID` | **Yes** for live Gmail | OAuth **web** client |
| `GOOGLE_CLIENT_SECRET` | **Yes** for live Gmail | Matching secret |
| `GOOGLE_REDIRECT_URI` | Strongly recommended | Must match Console exactly (local or prod callback URL) |
| `INBOXLINK_MODE` | Optional | Default **`single`** (no Bearer). Do not flip Production to `multi` without an explicit ops decision and a real API secret. |
| `INBOXLINK_API_SECRET` | If `multi` | Bearer for the default tenant (`/v1/*` except oauth/connect). Never commit real values. |
| `INBOXLINK_TENANT_ID` | Optional | Tenant id for `INBOXLINK_API_SECRET` (default `default`) |
| `INBOXLINK_TENANT_SECRETS` | Optional | Extra `tenantId=secret` pairs (comma/newline) for multiple host apps |
| `INBOXLINK_RATE_LIMIT_WINDOW_MS` / `INBOXLINK_RATE_LIMIT_MAX` | Optional | Soft in-process abuse guard in multi (defaults 60000 / 120) |
| `GMAIL_SCOPES` | Optional | Default readonly + openid email |
| `PORT` / `HOST` | Local only | Not used on Vercel |
| `REDIS_URL` | Optional | Queue stub |
| `INBOXLINK_WEBHOOK_SECRET` | Optional | Not required for Slice 1 / messages proof |

See [`.env.example`](.env.example) for placeholder shapes only.

### Proof curl script

Reproduce health → session → (browser Connect) → exchange → list grants → messages → optional revoke:

```bash
# Local (server already running):
./scripts/proof-curl.sh

# Production smoke (health + session create only until you Connect in a browser):
BASE_URL=https://inboxlink-two.vercel.app ./scripts/proof-curl.sh

# After Connect redirect, continue with tokens from your private notes:
PUBLIC_TOKEN=… ./scripts/proof-curl.sh exchange
GRANT_ID=grant_… EXTERNAL_USER_ID=proof-user-1 ./scripts/proof-curl.sh messages
GRANT_ID=grant_… ./scripts/proof-curl.sh revoke   # optional
```

Do **not** paste refresh tokens, Bearer secrets, or `public_token` values into git, PRs, or shared docs. Full Production runbook: keep a private copy of the 4-hour proof plan; this script covers the curl surface.

### Create a Link session (manual)

```bash
curl -sS -X POST http://localhost:8787/v1/link/sessions \
  -H 'content-type: application/json' \
  -d '{"externalUserId":"user-1","redirectUri":"http://localhost:9999/done"}'
```

Open the returned `connectUrl`. With placeholder Google credentials, the callback uses a **stub token exchange**. Put real `GOOGLE_CLIENT_*` values in `.env` to hit Google’s token endpoint.

List messages for a grant (`single` mode needs no API key):

```bash
curl -sS "http://localhost:8787/v1/grants/GRANT_ID/messages?limit=20"
```

Get one message with attachment metadata:

```bash
curl -sS "http://localhost:8787/v1/grants/GRANT_ID/messages/msg_PROVIDER_MESSAGE_ID"
```

`limit` is 1–25 (default 20). `cursor` is Gmail’s `nextPageToken`, returned as `nextCursor`. The JSON uses the normalized message fields (`providerMessageId`, `from`, `subject`, `snippet`, `receivedAt`, `folderIds`, `labels`, `hasAttachments`, optional `attachments` / `body`). It never includes the refresh token.

Demo host client:

```bash
pnpm --filter @inboxlink/demo start
```

## Vercel

`vercel.json` routes all traffic to `api/index.ts` wrapping `@inboxlink/server`. After deploy, `GET /health` should return JSON with `"store":"postgres"` when `DATABASE_URL` is set.

Set Project → Environment Variables from the checklist above (never commit Production secrets).

## Deferred (not in v0)

| Item | Notes |
|------|--------|
| Microsoft Graph adapter | Separate OAuth console + `MICROSOFT_*` env |
| IMAP adapter | App-password / password vaulting; security review first |
| npm publish (`@inboxlink/sdk` et al.) | Docs/SDK usage only until publish path is chosen |
| career-workspace host wiring | Optional **last**; core must stay independent |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks, PR expectations, and scope rules.

### Multi mode (optional)

Default mode is **`single`** — demos and Production should not flip to `multi` casually. When you do enable multi:

1. Set `INBOXLINK_MODE=multi` and a **non-placeholder** `INBOXLINK_API_SECRET` (hosted/production refuses the committed `dev-api-secret-change-me` value).
2. Host apps must send `Authorization: Bearer <secret>` on every host API (not Basic, not bare tokens).
3. Sessions, grant list/exchange/revoke, and messages are scoped to the tenant resolved from that Bearer secret.
4. `GET /v1/grants` returns a public grant shape (no `tenantId` / `externalUserId` in the JSON).
5. **Rotate** `INBOXLINK_API_SECRET` (or a row in `INBOXLINK_TENANT_SECRETS`) by deploying the new value, updating host clients, then retiring the old secret — never commit the secret.

Connect (`/v1/connect/...`) and the Gmail OAuth callback stay public (state-bound). Soft rate limits apply to connect and authenticated host routes in multi mode.

## Independence from career-workspace

- Separate GitHub repository and license.
- No imports, shared DB, or shared types with career-workspace.
- Job-application domain (Review Queue, classifiers, coach) stays out of this repo.

## License

[MIT](LICENSE)
