# Contributing to InboxLink

Thanks for helping build open-source mailbox connection infrastructure.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm --filter @inboxlink/server dev
```

Node **22+** and **pnpm** are required.

Optional durable local stack:

```bash
docker compose up -d
# Ensure DATABASE_URL in .env matches Compose (see .env.example)
pnpm --filter @inboxlink/server dev
curl -sS http://localhost:8787/health   # expect "store":"postgres"
```

### Checks before a PR

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

### Proof curl (smoke)

With the server running:

```bash
./scripts/proof-curl.sh
```

For Production health + session create only:

```bash
BASE_URL=https://inboxlink-two.vercel.app ./scripts/proof-curl.sh
```

Never commit output that contains `public_token`, API secrets, or refresh tokens.

## Env checklist (names only)

Copy [`.env.example`](.env.example) → `.env`. Set **names** below in Vercel or local env; never commit real values.

**Required for Production / live Connect:** `DATABASE_URL`, `INBOXLINK_MASTER_KEY`, `PUBLIC_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and matching `GOOGLE_REDIRECT_URI` in Google Console).

**Optional / conditional:** `INBOXLINK_MODE`, `INBOXLINK_API_SECRET` (if `multi`), `GMAIL_SCOPES`, `REDIS_URL`, `INBOXLINK_WEBHOOK_SECRET`, `PORT`, `HOST`.

Full table: [README.md](README.md#env-checklist-names-only).

## Architecture (short)

Host creates a **link session** → user opens **Connect** → Gmail OAuth callback → refresh token **sealed in the vault** → host **exchanges** one-time `public_token` for `grantId` → host **lists messages** (vault open → refresh → Gmail) → optional **revoke** destroys ciphertext.

Details and diagram: [README.md](README.md#architecture-overview).

## Scope

- This repo is **standalone**. Do not import or depend on [career-workspace](https://github.com/EtienneFokou-E18560/career-workspace).
- Prefer least-privilege Gmail scopes (`gmail.readonly`) unless a feature explicitly needs more.
- Never commit real OAuth client secrets, refresh tokens, or master keys. Use `.env.example` placeholders only.
- Prefer MIT/Apache dependencies only.

## Deferred work (do not assume in-scope)

Microsoft Graph, IMAP, Gmail history sync, polished Connect UI, npm publish, and career-workspace integration are **deferred**. Document stub vs production behavior in the PR when you touch OAuth, vault, or sync.

## Pull requests

- Run lint, typecheck, build, and tests before opening a PR.
- Keep changes focused; one concern per PR when practical.
- Mark PRs **draft** until CI is green and any secret / product gate in the approval hierarchy is cleared.
- Do not put Production URLs with live tokens, grant IDs tied to real mailboxes, or secret values in the PR body.
