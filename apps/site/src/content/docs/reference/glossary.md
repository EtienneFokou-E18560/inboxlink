---
title: Glossary
description: The words InboxLink's docs and API use.
---

**Host app**
: Your application. It calls the InboxLink API from its server with an API secret.

**Mailbox owner**
: The person whose Gmail is connected. They use your app and sign in with Google on InboxLink's Connect page.

**Tenant**
: One host app's space in an InboxLink server. Each tenant has its own API secret, grants and webhook endpoints, and cannot see another tenant's.

**API secret**
: The tenant's server credential, sent as `Authorization: Bearer`. Never sent to a browser.

**Connect session** (link session)
: A short-lived session your server creates for one person. It returns the `connectUrl` you send them to.

**`public_token`**
: The one-time token InboxLink adds to your `redirectUri` after a successful Connect. Your server exchanges it once for a grant.

**Grant** (`grantId`)
: A connected mailbox, owned by one of your users (`externalUserId`). The only thing your app stores. Status `active`, `needs_reauth` or `revoked`.

**`externalUserId`**
: Your own id for the person, stored on the grant. InboxLink does not interpret it.

**Vault**
: Where InboxLink keeps each grant's Google refresh token, encrypted with AES-256-GCM. Nothing outside the server ever reads it.

**Store** (synced cache)
: InboxLink's copy of a grant's messages, filled by sync jobs. The default source for `messages.list`.

**Live**
: `source: "live"`: a request that reads Gmail directly and supports search filters.

**Sync job**
: A queued task that brings the store up to date with Gmail. Returns a `jobId`; finishes as `completed` or `failed`.

**Webhook endpoint**
: A URL your tenant registers to receive signed events (`grant.connected`, `sync.completed`, …).
