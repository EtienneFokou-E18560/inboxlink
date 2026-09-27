# Host integration examples (optional)

> Suitable for **any** host app. This folder does not import career-workspace or any other product repo.

These sketches mirror [`docs/host-integration.md`](../../docs/host-integration.md):

1. `createConnectSession` → open `connectUrl`  
2. Host redirect receives `public_token`  
3. `completeConnect` → `grantId`

## Files

| File | Purpose |
|------|---------|
| `host.env.example` | **Host-only** env knobs (few). No `GOOGLE_*`. |
| `create-session.sh` | curl: create a session and print `connectUrl` |
| `done-handler.mjs` | Node: parse redirect query + exchange + optional message list |
| `sdk-host.mjs` | Same flow via `@inboxlink/sdk` (run from the monorepo after `pnpm build`) |

## Quick start against Production

No local InboxLink server required if you use the shared Production instance (Gmail OAuth already configured there):

```bash
pnpm --filter @inboxlink/core --filter @inboxlink/sdk build

# Production is multi — Bearer / apiSecret required (never commit the real value)
export INBOXLINK_API_SECRET=…   # from your secret store; not for browsers
export REDIRECT_URI=http://127.0.0.1:9999/done
node examples/host-integration/sdk-host.mjs
```

Open the printed `connectUrl`, finish Gmail Connect, then:

```bash
export INBOXLINK_API_SECRET=…   # same secret as above
node examples/host-integration/done-handler.mjs --url 'http://127.0.0.1:9999/done?public_token=…'
```

`GET /health` on Production is public and should report `"mode":"multi"`.

## Quick start (local server)

Terminal A — InboxLink server:

```bash
pnpm --filter @inboxlink/server dev
```

Terminal B (local default is often `single` — secret optional unless you set `INBOXLINK_MODE=multi`):

```bash
export INBOXLINK_BASE_URL=http://localhost:8787
# export INBOXLINK_API_SECRET=dev-api-secret-change-me   # only if local is multi
./examples/host-integration/create-session.sh
```

## Standing rule

InboxLink remains standalone mailbox infrastructure. Hosts consume the HTTP API or `@inboxlink/sdk`; this repository must not gain a dependency on any host application.
