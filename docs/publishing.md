# Publishing `@inboxlink/*` to npm

InboxLink does **not** publish on every merge. Releases are **manual and opt-in**.

## Packages intended for npm

| Package | Role |
|---------|------|
| `@inboxlink/core` | Types + crypto helpers (dependency of the SDK) |
| `@inboxlink/sdk` | Host-app HTTP client (Gmail list/get/sync; no Microsoft/IMAP client APIs) |

Server, adapters, connect-ui, and demo stay private / monorepo-only for now.

## Versioning

- Both publishable packages share the **0.x** series while the HTTP API is still settling.
- Treat **0.x minor bumps as potentially breaking** for consumers.
- Bump `packages/core/package.json` and `packages/sdk/package.json` `version` fields in the same PR before a real publish.
- Prefer publishing **core then sdk** so the SDK’s dependency resolves on the registry (`pnpm publish` rewrites `workspace:*`).

## Local dry-run (no token)

```bash
pnpm install
pnpm --filter @inboxlink/core --filter @inboxlink/sdk run build
pnpm --filter @inboxlink/sdk test
pnpm --filter @inboxlink/core publish --dry-run --no-git-checks
pnpm --filter @inboxlink/sdk publish --dry-run --no-git-checks
```

## GitHub Actions

Workflow: [`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml)

- Trigger: **Actions → Publish npm packages → Run workflow** (`workflow_dispatch` only).
- Default `dry_run=true` packs and runs `publish --dry-run` (no registry write).
- Set `dry_run=false` only when intentionally releasing.

### Provenance (private vs public source repo)

npm **provenance** attestations are only supported when the GitHub **source** repository is **public**. Publishing from a private (or internal) repo with provenance enabled fails with:

> Unsupported GitHub Actions source repository visibility: "private"

InboxLink handles this as follows:

- `@inboxlink/core` and `@inboxlink/sdk` do **not** set `publishConfig.provenance: true` in `package.json` (that flag overrides env and forces provenance even when `NPM_CONFIG_PROVENANCE=false`).
- `publish-npm.yml` reads `github.repository_visibility`:
  - **private / internal** → publishes **without** provenance (`NPM_CONFIG_PROVENANCE=false`).
  - **public** → publishes **with** provenance (`--provenance` / `NPM_CONFIG_PROVENANCE=true`).

**Making the GitHub repository public automatically re-enables provenance** on the next workflow run — no package.json change required.

**Long-term recommendation for MIT OSS:** make [`EtienneFokou-E18560/inboxlink`](https://github.com/EtienneFokou-E18560/inboxlink) **public** so releases carry provenance trust signals consumers expect.

### Auth (do not publish without credentials)

**Preferred — npm Trusted Publishing (OIDC)**

1. On npmjs.com, configure a Trusted Publisher for each package:
   - GitHub repository: `EtienneFokou-E18560/inboxlink`
   - Workflow filename: `publish-npm.yml` (exact name; top-level workflow only)
2. Use Node 22+ and npm ≥ 11.5.1 (the workflow upgrades npm).
3. Optional: add a GitHub Environment with required reviewers for real publishes.

**Fallback — granular `NPM_TOKEN`**

- Store a granular automation token as repo secret `NPM_TOKEN`.
- Prefer **stage-only** write tokens (`npm stage publish` + maintainer 2FA approve) when available.
- Never commit tokens; rotate if exposed.

Without OIDC or `NPM_TOKEN`, a non-dry-run publish fails closed.

## License headers

Publishable package sources carry SPDX MIT headers. Packaging includes `LICENSE` and `README.md` via each package’s `files` field.
