# `@inboxlink/sdk` changelog

## 0.1.1

Release notes for hosts upgrading from `0.1.0`.

### Message list filters

`messages.list` / `messages.iterate` now forward Gmail list filters to
`GET /v1/grants/:id/messages` (requires a Production / self-host that includes #35):

| Option | Behavior |
|--------|----------|
| `q` | Gmail search query (e.g. `is:unread newer_than:7d`) |
| `from` / `to` / `subject` | Structured header matchers (AND-merged into `q`) |
| `label` | Gmail label id(s) → `labelIds` (string or string[]) |
| `includeSpamTrash` | Include SPAM/TRASH in results |

### Other notes since 0.1.0

- No breaking changes to existing Connect / grants / get / sync method signatures.
- Server-side host redirect allowlisting (#24) may reject unknown `redirectUri` values when operators configure an allowlist — unrelated to this package’s API surface, but visible to hosts on Production.
- Publish path unchanged: Actions → **Publish npm packages** (`publish-npm.yml`, `workflow_dispatch`). Public GitHub source enables npm provenance on this release.

## 0.1.0

Initial public npm release: Connect helpers, grants, message list/get, history sync, and Production defaults for single-mode hosts.
