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

## Pull requests

- Run `pnpm lint`, `pnpm typecheck`, and `pnpm build` before opening a PR.
- Keep changes focused; document stub vs production behavior in the PR body when touching OAuth or vault code.

## Suggested merge hierarchy (optional slices)

Core connect + messages land first. Host-integration docs/examples ([docs/host-integration.md](docs/host-integration.md), Slice J) are **optional and last** — merge only when you want a host product path. They must not introduce a dependency on career-workspace or any other host app.
