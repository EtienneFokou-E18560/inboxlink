---
title: Self-hosting and operations
description: Run your own InboxLink server, check its health and keep Gmail sync running.
---

InboxLink is a Hono app deployed as one Vercel function (`api/index.ts`)
with Postgres. You need your own Google OAuth client to run it.

## Run it locally

```bash
git clone https://github.com/EtienneFokou-E18560/inboxlink.git
cd inboxlink
cp .env.example .env    # placeholders only
pnpm install && pnpm build
docker compose up -d    # Postgres
pnpm --filter @inboxlink/server dev
```

Tables are created at startup. Without `DATABASE_URL` the server keeps data
in memory: fine for a demo, never for real mailboxes.

## Settings (names only)

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | Postgres |
| `INBOXLINK_MASTER_KEY` | Key that encrypts the token vault |
| `PUBLIC_BASE_URL` | The server's public address |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Your Google OAuth client |
| `INBOXLINK_MODE` | `single` (default, no API secret) or `multi` |
| `INBOXLINK_API_SECRET`, `INBOXLINK_TENANT_SECRETS` | API secrets per tenant in `multi` mode |
| `ALLOWED_REDIRECT_ORIGINS` | Which host origins may receive Connect redirects |
| `INBOXLINK_CONNECT_POLICY` | Tenants that reuse a grant on reconnect (`tenantId=reuse`) |
| `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_SECRET`, `CRON_SECRET` | Gmail push and scheduled jobs |

Never put values in git, issues or chat. See [`.env.example`](https://github.com/EtienneFokou-E18560/inboxlink/blob/main/.env.example).

## Health

`GET /health` is public and never shows secrets.

| Answer | Meaning |
|---|---|
| `200`, `"store":"postgres"` | Ready for real Connects |
| `200`, `"store":"memory"` | Data is lost on restart: do not connect real mailboxes |
| `503`, `database_unavailable` | Check Postgres and `DATABASE_URL` |

```bash
pnpm smoke:health https://inboxlink-two.vercel.app
```

The hosted service also has a human-readable
[status page](https://inboxlink-two.vercel.app/status).

## Gmail push and scheduled jobs

Polling with `POST …/sync` always works. For near-real-time mail:

1. Create a Pub/Sub topic and give **Publisher** to
   `gmail-api-push@system.gserviceaccount.com`.
2. Point a push subscription at
   `https://<host>/v1/internal/gmail/push?token=<GMAIL_PUSH_SECRET>`.
3. Set `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_SECRET` and `CRON_SECRET`.

Two scheduled jobs keep things moving: `renew-gmail-watches` (daily) and
`drain-sync-jobs`. Vercel's Hobby plan only allows daily cron jobs, so the
repository also runs the drain from a GitHub Action.

Full runbook: [ops-runbook.md](https://github.com/EtienneFokou-E18560/inboxlink/blob/main/docs/ops-runbook.md).
