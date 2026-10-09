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
- Add or update each package’s `CHANGELOG.md` in that same PR (shipped in the npm tarball via `files`).
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

### Auth: no token needed (npm Trusted Publishing)

The workflow publishes with npm **Trusted Publishing** (OIDC). GitHub proves its identity to npm
for each run, so there is **no token to create, expire or leak**. (npm limits write tokens to a short
lifetime, so a token would need replacing again and again.)

**One-time setup, on npmjs.com, for each of `@inboxlink/core` and `@inboxlink/sdk`:**

1. Open the package page, then **Settings**, then **Trusted Publisher**, and choose **GitHub Actions**.
2. Fill in exactly:
   - Organization or user: `EtienneFokou-E18560`
   - Repository: `inboxlink`
   - Workflow filename: `publish-npm.yml` (the name only, not the path)
   - Environment name: leave empty (the workflow does not use a GitHub Environment)
3. Save. Do the same for the other package.

Then run **Actions, Publish npm packages, Run workflow** with `dry_run` off. Core is published first, then the SDK;
a version already on the registry is skipped, so a partly failed run can be re-run.

Afterwards you can tighten each package under **Settings, Publishing access**: *Require two-factor
authentication and disallow tokens*. Publishing then works only through the trusted workflow (or a
person with 2FA). Delete any old `NPM_TOKEN` repository secret.

What the workflow does for this: it has `id-token: write`, installs npm 11.5.1 or newer (needed for Trusted
Publishing), packs each package with `pnpm pack` (which rewrites `workspace:*` to the real version) and uploads
the tarball with `npm publish`. If it fails with an authentication error, the Trusted Publisher entry is
missing or does not match the repository and workflow filename above.

**Optional fallback: a granular `NPM_TOKEN` secret.** If the secret exists the workflow uses it instead of OIDC.
Prefer not to: tokens expire.

Without a configured Trusted Publisher (or a token), a real publish fails closed.

## License headers

Publishable package sources carry SPDX MIT headers. Packaging includes `LICENSE` and `README.md` via each package’s `files` field.
