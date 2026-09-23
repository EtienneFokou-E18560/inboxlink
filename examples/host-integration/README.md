# Host integration examples (optional)

> Part of **Slice J** — optional docs/examples only. Last in the suggested merge hierarchy.  
> Suitable for **any** host app. This folder does not import career-workspace or any other product repo.

These sketches mirror the flow in [`docs/host-integration.md`](../../docs/host-integration.md):

1. Create link session  
2. Open / redirect to `connectUrl`  
3. Read `public_token` from the host redirect  
4. Exchange for `grantId`

## Files

| File | Purpose |
|------|---------|
| `create-session.sh` | curl: create a session and print `connectUrl` |
| `done-handler.mjs` | Node: parse redirect query + exchange + optional message list |
| `sdk-host.mjs` | Same flow via `@inboxlink/sdk` (run from the monorepo after `pnpm build`) |

## Quick start (local)

Terminal A — InboxLink server:

```bash
pnpm --filter @inboxlink/server dev
```

Terminal B — create a session:

```bash
export INBOXLINK_BASE_URL=http://localhost:8787
export INBOXLINK_API_SECRET=dev-api-secret-change-me
./examples/host-integration/create-session.sh
```

Open the printed `connectUrl`. After OAuth (or stub exchange), InboxLink redirects to the `redirectUri` you set (default in the script is `http://127.0.0.1:9999/done`). Point that URI at `done-handler.mjs` or paste the `public_token` into:

```bash
node examples/host-integration/done-handler.mjs --public-token '<token>'
```

## Standing rule

InboxLink remains standalone mailbox infrastructure. Hosts consume the HTTP API or `@inboxlink/sdk`; this repository must not gain a dependency on any host application.
