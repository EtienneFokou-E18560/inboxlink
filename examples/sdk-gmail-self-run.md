# SDK Gmail self-run (grant-based)

Exercise `@inboxlink/sdk` from the monorepo against Production (or a local server) using an existing Gmail `grantId`. No npm publish required.

## Prerequisites

- Node 22+
- Built packages: `@inboxlink/core` and `@inboxlink/sdk`
- An **active** Gmail grant on the target InboxLink instance

## Commands

```bash
pnpm install
pnpm --filter @inboxlink/core --filter @inboxlink/sdk build

export INBOXLINK_BASE_URL=https://inboxlink-two.vercel.app
export GRANT_ID=grant_…   # your active grant
# Production is currently single-mode; the SDK still sends Bearer:
export INBOXLINK_API_SECRET=unused-in-single-mode

node examples/sdk-gmail-self-run.mjs
```

Local server alternative: set `INBOXLINK_BASE_URL=http://localhost:8787` and run `pnpm --filter @inboxlink/server dev` first.

## What it checks

| Step | SDK call | Expect |
|------|----------|--------|
| List | `messages.list(grantId, { limit: 3 })` | HTTP 200, ≥1 message |
| Get | `messages.get(grantId, id)` | `message.body.text` and/or `message.body.html` present (not snippet-only) |
| Sync | `grants.sync(grantId)` | `status: "ok"` |

Attachment **bytes** are out of scope; attachment **metadata** may appear on messages.

## CORS

This script is **Node-only**. Production does not need CORS for server-side SDK use. Browser hosts must call InboxLink from their backend (never ship `INBOXLINK_API_SECRET` to the browser).

## Secrets

Do not commit `GRANT_ID`, API secrets, refresh tokens, or `public_token` values. The script prints body **lengths**, not email content.
