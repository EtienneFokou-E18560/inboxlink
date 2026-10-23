---
title: Security
description: How InboxLink protects mailbox access, and how to report a vulnerability.
---

## How tokens are kept

- Google refresh tokens are encrypted with AES-256-GCM in InboxLink's vault.
  Host apps only ever hold a `grantId`.
- Short-lived access tokens are cached in memory per grant; refresh tokens
  never leave the vault.
- Revoking a grant deletes its sealed token and cached messages.
- When Google refuses a token, the grant stops working (`needs_reauth`)
  instead of retrying forever.
- Connect uses S256 PKCE, and each Google `state` can be used once.

## What InboxLink stores, and what it never stores

| Stored | How | Removed when |
|---|---|---|
| Google refresh token | Encrypted in the vault (AES-256-GCM), never returned by the API | The grant is revoked or replaced |
| Mailbox address, `externalUserId`, grant status | Postgres | The grant is revoked. A replaced grant keeps this record (no token, no messages) so your app can see `replaced: true` |
| Copy of synced messages (headers, snippet, labels, and the full message for messages fetched one by one) | Postgres | The grant is revoked or replaced |
| Access tokens | Server memory only, short-lived | They expire |

**Never stored:** the person's Google password (typed on Google's page only),
attachment file contents, and tokens or secrets in logs (logs redact them).
Reducing what is kept is planned in
[#86](https://github.com/EtienneFokou-E18560/inboxlink/issues/86).

## Who handles what

| InboxLink handles | Your app handles |
|---|---|
| Google OAuth client, PKCE and `state` checks | Keeping the API secret on your server |
| Encrypting and refreshing tokens | Exchanging `public_token` on your server, once |
| Stopping access when Google refuses a token | Tying each `grantId` to the right user and sending `externalUserId` |
| Deleting the token and cache on revoke | Calling revoke when a user disconnects or deletes their account |
| Signing webhooks | Verifying the signature on the raw body |
| Keeping tenants apart | Telling your users what your app does with their mail |

## Rules for host apps

- Keep the API secret on your server. Never ship it in browser or mobile code.
- Exchange `public_token` on your server, once.
- Verify webhook signatures on the raw body before parsing.
- Rotate a secret by deploying the new one, updating your app, then removing
  the old one.

## Report a vulnerability

Do **not** open a public issue for anything involving tokens, keys, API
secrets or mailbox data. Use GitHub's
[private vulnerability reporting](https://github.com/EtienneFokou-E18560/inboxlink/security/advisories/new)
and include the impact, the component (SDK, server, Connect) and whether the
hosted service or a self-host was involved. Never attach live tokens, keys or
message bodies.

Full policy: [SECURITY.md](https://github.com/EtienneFokou-E18560/inboxlink/blob/main/SECURITY.md).

## Policies

The hosted service's [privacy policy](https://inboxlink-two.vercel.app/privacy)
and [terms](https://inboxlink-two.vercel.app/terms).
