---
title: Roadmap
description: What InboxLink supports today, what is being built, and what is planned.
---

InboxLink is built in the open. Each item links to its GitHub issue, where
you can follow progress or say what you need.

## Project status

- **Version 0.x.** The API can still change between minor versions; the
  [changelog](/changelog/) says when a host needs to act.
- **One maintainer.** Issues and pull requests are welcome; answers can take
  a few days.
- **Hosted service by request, free, no SLA.** It runs on Vercel and Neon
  Postgres. For guarantees, [run your own](/operate/self-host/).
- **Security reports** go through [the Security page](/security/#report-a-vulnerability),
  never public issues.

## Available

- Gmail: Connect, message list and get, live Gmail search, history sync,
  Gmail push, signed webhooks, per-tenant webhook endpoints.
- `@inboxlink/sdk` and `@inboxlink/core` on npm, published with provenance.
- Self-hosting on Vercel and Postgres.

## Next

- **Keep less mail**: inbox only, no stored bodies, encrypted metadata that
  expires ([#86](https://github.com/EtienneFokou-E18560/inboxlink/issues/86)),
  and letting a host mark messages processed so InboxLink forgets their
  subject and snippet ([#87](https://github.com/EtienneFokou-E18560/inboxlink/issues/87)).
- **Revoking cleans up fully** even when a delete step fails
  ([#88](https://github.com/EtienneFokou-E18560/inboxlink/issues/88)).
- **OpenAPI spec and API reference** generated from the server
  ([#91](https://github.com/EtienneFokou-E18560/inboxlink/issues/91)).

## Planned

- **Google Calendar**: read-only events and free/busy for a grant
  ([#85](https://github.com/EtienneFokou-E18560/inboxlink/issues/85)).
- **Microsoft 365 / Outlook** through Microsoft Graph. An adapter exists but
  is paused until Gmail is complete.
- **IMAP** with app passwords. An adapter exists but is paused for the same
  reason.

Want something else? [Open an issue](https://github.com/EtienneFokou-E18560/inboxlink/issues/new).
