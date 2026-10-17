# InboxLink: rules for agents

- Commit only as the maintainer: `Etienne Fokou <fokou.etienne@gmail.com>`. No co-author trailers, no "Generated with/by" lines, no attribution in PR bodies. CI enforces this (`.github/workflows/authorship.yml`); see CONTRIBUTING.md, "Authorship".
- Dependency updates are done by hand from the weekly dependency report; do not add Dependabot version updates.
- Gates before a PR: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm check:docs`.
