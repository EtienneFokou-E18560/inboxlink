# InboxLink

**Open-source “Plaid for email mailboxes.”**

InboxLink is standalone **mailbox connection infrastructure**: Link-style Connect, vaulted OAuth tokens, and a normalized messages API so host apps never hold Gmail refresh tokens.

It does **not** depend on [career-workspace](https://github.com/EtienneFokou-E18560/career-workspace). That app may become a later *consumer* via `@inboxlink/sdk` — never the other way around.

## Status (v0 scaffold)

Working TypeScript monorepo with:

- Gmail OAuth **authorization URL + callback** stubs
- Encrypted **token vault** interface (in-memory AES-GCM for local demos)
- HTTP API skeleton (`/v1/link/sessions`, grants exchange, health)
- Postgres **Drizzle schema stubs** + raw SQL export
- Optional Redis/BullMQ **queue placeholder**

Not yet: production Google OAuth against real secrets, Gmail history sync, Microsoft/IMAP adapters, npm publish.

## Packages

| Package | Role |
|---------|------|
| `@inboxlink/core` | Types, vault crypto helpers, adapter interfaces |
| `@inboxlink/adapters-gmail` | Gmail OAuth adapter (URL + token exchange) |
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

Health check: [http://localhost:8787/health](http://localhost:8787/health)

### Vercel

`src/index.ts` default-exports the Hono app, which is the entry [Vercel’s Hono preset](https://vercel.com/docs/frameworks/backend/hono) deploys. `vercel.json` sets `"framework": "hono"` and runs `pnpm build` so workspace packages emit `dist/` before that entry is bundled. After deploy, `GET /health` should return JSON.

Note: v0 uses an **in-memory** store on Vercel — grants reset on cold starts. Use the long-running server + Postgres for anything real.

Set Project → Environment Variables from `.env.example` (placeholders only; no production secrets in git).

Create a Link session:

```bash
curl -s -X POST http://localhost:8787/v1/link/sessions \
  -H 'content-type: application/json' \
  -d '{"externalUserId":"user-1","redirectUri":"http://localhost:9999/done"}'
```

Open the returned `connectUrl`. With placeholder Google credentials, the callback uses a **stub token exchange** (no real Google call). Put real `GOOGLE_CLIENT_*` values in `.env` to hit Google’s token endpoint.

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
| `DATABASE_URL` | Postgres (schema ready; store still in-memory in v0) |
| `REDIS_URL` | Optional BullMQ placeholder |

## Independence from career-workspace

- Separate GitHub repository and license.
- No imports, shared DB, or shared types with career-workspace.
- Job-application domain (Review Queue, classifiers, coach) stays out of this repo.

## License

[MIT](LICENSE)
