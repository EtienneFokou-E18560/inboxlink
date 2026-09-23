# InboxLink

**Open-source “Plaid for email mailboxes.”**

InboxLink is standalone **mailbox connection infrastructure**: Link-style Connect, vaulted OAuth tokens, and a normalized messages API so host apps never hold Gmail refresh tokens.

It does **not** depend on [career-workspace](https://github.com/EtienneFokou-E18560/career-workspace). That app may become a later *consumer* via `@inboxlink/sdk` — never the other way around.

## Status (v0 scaffold)

Working TypeScript monorepo with:

- Gmail OAuth **authorization URL + callback** (real Google token exchange when `GOOGLE_CLIENT_*` are set; placeholder credentials use a stub exchange)
- Microsoft Graph OAuth **authorization URL + callback** (real Entra token exchange when `MICROSOFT_CLIENT_*` are set; placeholder credentials use a stub exchange). Default authority tenant is `common` (personal Microsoft accounts + work/school)
- Encrypted **token vault** (in-memory AES-256-GCM; revoke deletes the ciphertext)
- HTTP API skeleton (`/v1/link/sessions`, grants exchange, health)
- Postgres **Drizzle schema stubs** + raw SQL export
- Optional Redis/BullMQ **queue placeholder**

`GET /v1/grants/:grantId/messages` lists Gmail or Microsoft messages for an active grant. The server opens the vaulted refresh token, exchanges it for an access token, and returns the normalized message shape. History/delta sync, IMAP, and npm publish are not implemented.

Live acceptance needs a connected Gmail or Microsoft grant. No extra secrets beyond the OAuth clients, `INBOXLINK_MASTER_KEY`, and `DATABASE_URL` on Vercel. CI uses local HTTP stand-ins and does not call Google or Microsoft.

On Vercel, set `DATABASE_URL` to a Postgres database the functions can reach. The server creates the tables and the `default` tenant on startup. Without `DATABASE_URL`, sessions and grants stay in process memory and a callback on another instance returns Unknown OAuth state.

A real Gmail connect needs these **user-held** values in the environment (never commit them):

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth client (not `GOOGLE_APPLICATION_CREDENTIALS_JSON`)
- `GOOGLE_REDIRECT_URI` exactly matching the callback, for production `https://inboxlink-two.vercel.app/v1/oauth/gmail/callback`
- `PUBLIC_BASE_URL` set to that same origin
- `INBOXLINK_MASTER_KEY` (16+ characters) and `INBOXLINK_API_SECRET`
- The Gmail account added as a test user on the OAuth consent screen

A real Microsoft connect needs (never commit them):

- `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` from an Entra ID app registration
- Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (`AzureADandPersonalMicrosoftAccount`) to match the default `MICROSOFT_TENANT=common`
- Redirect URI (Web): `MICROSOFT_REDIRECT_URI` = `https://inboxlink-two.vercel.app/v1/oauth/microsoft/callback` (or local equivalent)
- API permission: Microsoft Graph delegated `Mail.Read` (plus `openid` / `offline_access` / `email` via scopes)
- Optional: set `MICROSOFT_TENANT=organizations` or a directory tenant id to restrict work/school only

With `DATABASE_URL` set, grants and vault ciphertext are stored in Postgres and shared by every instance. `GET /health` then reports `"store":"postgres"`. Without that variable, storage stays in process memory (`"store":"memory"`).

## Packages

| Package | Role |
|---------|------|
| `@inboxlink/core` | Types, vault crypto helpers, adapter interfaces |
| `@inboxlink/adapters-gmail` | Gmail OAuth + message list adapter |
| `@inboxlink/adapters-microsoft` | Microsoft Graph OAuth + message list adapter |
| `@inboxlink/sdk` | Host-app HTTP client |
| `@inboxlink/server` | Hono HTTP service |
| `@inboxlink/connect-ui` | Stub (server ships minimal Connect HTML for now) |
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

Health check: [http://localhost:8787/health](http://localhost:8787/health). `GET /` and `GET /health/` return the same JSON.

### Vercel

`vercel.json` routes all traffic to a Node serverless entry (`api/index.ts`) wrapping `@inboxlink/server` (Hono). After deploy, `GET /health` should return JSON.

Set `DATABASE_URL` on the Vercel project (Production, Secret) before a live connect. `GET /health` includes `"store":"postgres"` when that database is in use. The server applies `GET /v1/schema.sql` itself on startup.

Set Project → Environment Variables from `.env.example` (placeholders only; no production secrets in git).

Create a Link session:

```bash
curl -s -X POST http://localhost:8787/v1/link/sessions \
  -H 'content-type: application/json' \
  -d '{"externalUserId":"user-1","redirectUri":"http://localhost:9999/done"}'
```

Open the returned `connectUrl`. Choose **Continue with Google** or **Continue with Microsoft**. With placeholder credentials, the callback uses a **stub token exchange** (no real IdP call). Put real `GOOGLE_CLIENT_*` or `MICROSOFT_CLIENT_*` values in `.env` to hit the live token endpoint.

List messages for a grant (single mode needs no API key):

```bash
curl -s "http://localhost:8787/v1/grants/GRANT_ID/messages?limit=20"
```

`limit` is 1–25 (default 20). `cursor` is the provider page token (`nextPageToken` for Gmail, `$skiptoken` for Graph), returned as `nextCursor`. The JSON uses the normalized message fields (`providerMessageId`, `from`, `subject`, `snippet`, `receivedAt`, `folderIds`, `labels`, `hasAttachments`, optional `body`). It never includes the refresh token.

Demo host client:

```bash
pnpm --filter @inboxlink/demo start
```

## Docker (optional Postgres + Redis)

```bash
docker compose up -d
# server still runs via pnpm for v0; DATABASE_URL / REDIS_URL point at Compose services
```

Apply schema stub (when using Postgres):

```bash
curl -s http://localhost:8787/v1/schema.sql | psql "$DATABASE_URL"
```

## Environment

See [`.env.example`](.env.example). Placeholders only — never commit real secrets.

| Variable | Purpose |
|----------|---------|
| `INBOXLINK_MODE` | `single` (default) or `multi` |
| `INBOXLINK_MASTER_KEY` | Envelope encryption key for the vault |
| `INBOXLINK_API_SECRET` | Bearer secret for host APIs in `multi` mode |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth client |
| `GOOGLE_REDIRECT_URI` | Gmail OAuth callback URL |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Entra app registration (Graph mail) |
| `MICROSOFT_REDIRECT_URI` | Microsoft OAuth callback URL |
| `MICROSOFT_TENANT` | Authority tenant (`common` default; or `organizations` / tenant id) |
| `MICROSOFT_SCOPES` | Delegated Graph scopes (default includes `Mail.Read` + `offline_access`) |
| `DATABASE_URL` | Postgres for sessions, grants, and vault ciphertext. Unset uses in-memory storage |
| `REDIS_URL` | Optional BullMQ placeholder |

## Independence from career-workspace

- Separate GitHub repository and license.
- No imports, shared DB, or shared types with career-workspace.
- Job-application domain (Review Queue, classifiers, coach) stays out of this repo.

## License

[MIT](LICENSE)
