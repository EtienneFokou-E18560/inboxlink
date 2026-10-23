---
title: Connect flow
description: How a person connects a Gmail mailbox to your app through InboxLink, and what happens when they connect again.
---

The person never leaves InboxLink's pages while Google is involved. Your app
only sees a one-time token on the way back, which it swaps for a `grantId`.

```text
Your server                     InboxLink                        Browser
     |                               |                               |
     |-- POST /v1/link/sessions ---->|                               |
     |<-- { connectUrl } ------------|                               |
     |-- redirect to connectUrl ------------------------------------>|
     |                               |<-- Connect page + Google -----|
     |                               |-- 302 to your redirectUri --->|
     |<-- GET ?public_token=… ---------------------------------------|
     |-- POST /v1/grants/exchange -->|                               |
     |<-- { grantId } ---------------|                               |
```

## Who configures what

| | Who |
|---|---|
| Google OAuth client (`GOOGLE_*`) | InboxLink server only |
| Postgres, vault, master key | InboxLink server only |
| API secret (`Authorization: Bearer`) | Your server |
| `redirectUri` | Your app: a route that receives `public_token` |

## 1. Create a session

```ts
const session = await il.createConnectSession({
  externalUserId: user.id, // your id for this person
  redirectUri: "https://your-app.example.com/inboxlink/done",
});
```

`POST /v1/link/sessions` takes `externalUserId`, `redirectUri` and optional
`products` (default `["messages"]`). Without the API secret the hosted
service answers **401**. A server that sets `ALLOWED_REDIRECT_ORIGINS` refuses
other origins with `redirectUri_not_allowed`.

## 2. Send the person to `connectUrl`

The Connect page starts Google sign-in with S256 PKCE and binds Google's
`state` to the session. The callback consumes that state once: replaying the
callback URL shows an error page. If Google does not return a refresh token,
no grant is created.

## 3. Handle the redirect

On success InboxLink redirects to your `redirectUri` with `public_token`
(and `link_token` for correlation). Exchange it **on your server**:

```ts
const { grantId } = await il.completeConnect({ redirectUrl: request.url });
```

The token works once. If Google sign-in fails, InboxLink shows its own error
page and does not redirect, so a request without `public_token` means the
connection did not finish.

When the person comes back with an expired or already-used session, the error
page offers **Start again**. It sends them to your `redirectUri` with
`error=connect_restart`: create a new session and redirect again.

## Connecting the same mailbox again

A mailbox (tenant + provider + address) has one live grant. What a new Connect
of the same address does is set per tenant on the server
(`INBOXLINK_CONNECT_POLICY`):

| Setting | Same address as a live grant |
|---|---|
| `replace` (default) | A new grant. The old one is retired: token and cached messages deleted, calls answer **409 `grant_replaced`**. |
| `reuse` | The same `grantId` gets the fresh token, keeps its cache and belongs to the person who just connected. |

A **different** address is added next to the person's other grants. If your
app asked them to replace a mailbox, pass that grant's id as
`replacesGrantId` in `link.createSession` and it is retired when they
connect a different address.

When a Connect takes a mailbox away from another of your users, that user's
grant answers `grant_replaced` and you receive a `grant.revoked` webhook.
Send `externalUserId` on grant calls so a stale user cannot read a mailbox
that moved.

More detail: [host-integration.md](https://github.com/EtienneFokou-E18560/inboxlink/blob/main/docs/host-integration.md).
