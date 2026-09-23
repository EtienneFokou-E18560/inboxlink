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

## Scope

- This repo is **standalone**. Do not import or depend on [career-workspace](https://github.com/EtienneFokou-E18560/career-workspace).
- Prefer least-privilege Gmail scopes (`gmail.readonly`) unless a feature explicitly needs more.
- Never commit real OAuth client secrets, refresh tokens, or master keys. Use `.env.example` placeholders only.
- Prefer structured logs via `@inboxlink/server` `log` helpers (secrets are redacted). See [docs/ops-runbook.md](docs/ops-runbook.md).

## Pull requests

- Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before opening a PR.
- Keep changes focused; document stub vs production behavior in the PR body when touching OAuth or vault code.
