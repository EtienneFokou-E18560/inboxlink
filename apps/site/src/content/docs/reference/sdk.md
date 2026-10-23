---
title: SDK reference
description: Every method of @inboxlink/sdk, the TypeScript client for host apps.
---

```bash
npm install @inboxlink/sdk
```

Current version: **`@inboxlink/sdk@0.2.0`**, with `@inboxlink/core@0.2.0`.
InboxLink is 0.x: treat minor versions as possibly breaking and read the
[changelog](https://github.com/EtienneFokou-E18560/inboxlink/blob/main/packages/sdk/CHANGELOG.md) before upgrading.

## Client

```ts
import { InboxLink, InboxLinkApiError } from "@inboxlink/sdk";

const il = new InboxLink({
  apiSecret: process.env.INBOXLINK_API_SECRET, // server only
  // baseUrl: "http://localhost:8787",          // self-host; defaults to the hosted service
});
```

Omit `apiSecret` only against a self-host running `INBOXLINK_MODE=single`.
Failed calls throw `InboxLinkApiError`: `status` is the HTTP status and `code`
the `error` value from the [Messages API](/guides/messages/#errors).

## Methods

| Area | Method | HTTP |
|---|---|---|
| Connect | `createConnectSession({ externalUserId, redirectUri })` | `POST /v1/link/sessions` |
| | `link.createSession({ …, replacesGrantId })` | `POST /v1/link/sessions` |
| | `completeConnect({ redirectUrl })` or `({ publicToken })` | `POST /v1/grants/exchange` |
| Grants | `grants.list(externalUserId)` | `GET /v1/grants?externalUserId=` |
| | `grants.listAll({ limit, cursor })`, `grants.iterateAll()` | `GET /v1/grants?all=true` |
| | `grants.revoke(grantId)` | `DELETE /v1/grants/:id` |
| | `grants.sync(grantId, { mode })` | `POST /v1/grants/:id/sync` |
| | `grants.getSyncJob(grantId, jobId)` | `GET /v1/grants/:id/sync/jobs/:jobId` |
| Messages | `messages.list(grantId, options)` | `GET /v1/grants/:id/messages` |
| | `messages.iterate(grantId, options)` | same, every page |
| | `messages.get(grantId, messageId)` | `GET /v1/grants/:id/messages/:messageId` |
| Webhooks | `webhooks.verify({ payload, signatureHeader, secret })` | local HMAC check |
| Helpers | `parseConnectRedirect`, `connectUrlForToken`, `INBOXLINK_PRODUCTION_URL` | local |

Grant calls (`messages.*`, `grants.sync`, `getSyncJob`, `revoke`) accept
`{ externalUserId }`: the call then answers **409 `grant_replaced`** if the
grant now belongs to another of your users.

`grants.listAll` returns ids, owner, provider, status, dates and
`lastSyncAt` for every grant in your tenant, oldest first. It never returns
addresses or tokens.

## Host environment

```bash
INBOXLINK_API_SECRET=...        # required for the hosted service
INBOXLINK_BASE_URL=...          # only for a self-host
INBOXLINK_WEBHOOK_SECRET=...    # only if you receive webhooks
```

Do not copy the server's `.env.example` into your app: it holds Google,
Postgres and vault settings that only the InboxLink server needs.
