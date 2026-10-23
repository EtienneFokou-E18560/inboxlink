---
title: Messages API
description: List, search and read messages for a grant, from the synced cache or live from Gmail.
---

Every call needs `Authorization: Bearer <API secret>` (SDK: `apiSecret`).

## Two sources

| | `source=store` (default) | `source=live` |
|---|---|---|
| Reads from | InboxLink's synced cache | Gmail, at request time |
| Filters | Ignored | `q`, `from`, `to`, `subject`, `label`, `includeSpamTrash` |
| Freshness | `syncedAt` and `historyId` of the last sync | Live |
| Needs a sync first | Yes | No |

:::caution
Filters only apply with `source: "live"`. On the default cache they are
ignored, so a filtered call without `source: "live"` returns unfiltered mail.
:::

## List

```ts
await il.grants.sync(grantId); // fill the cache first
const page = await il.messages.list(grantId, { limit: 25 });

const unread = await il.messages.list(grantId, {
  source: "live",
  q: "is:unread newer_than:7d",
  label: ["INBOX"],
  from: "ada@example.com",
});
```

```http
GET /v1/grants/:grantId/messages?source=live&label=INBOX&limit=20
Authorization: Bearer <API secret>
```

| Parameter | Meaning |
|---|---|
| `limit` | 1 to 25, default 20 |
| `cursor` | The `nextCursor` of the previous page |
| `q` | Any Gmail search string (live) |
| `from` / `to` / `subject` | Added to `q` (live) |
| `label` | Repeatable, Gmail label ids such as `INBOX` or `UNREAD` (live) |
| `includeSpamTrash` | `true` or `false` (live) |

Invalid filters answer **400** without calling Gmail. `messages.iterate`
walks every page for you.

Live messages also carry `headers.listUnsubscribe`, `headers.precedence`
and `headers.autoSubmitted` when the message has them, to spot bulk mail.

## Get one message

```ts
const { message } = await il.messages.get(grantId, messageId);
```

Returns the full message, including the body and attachment metadata (id,
filename, MIME type, size), not attachment bytes. The id can be InboxLink's
`msg_…` id or the Gmail id.

## Errors

| Status | `error` | What to do |
|---|---|---|
| 404 | `not_found` | The grant does not exist in your tenant. |
| 409 | `needs_reauth` | Google just refused the token. Send the person through Connect again. |
| 409 | `grant_inactive` | The grant is already `needs_reauth` or revoked. Same fix: Connect again. |
| 409 | `grant_replaced` | The mailbox was connected again (maybe by another of your users). Stop using this grant for this user. |
| 502 | `gmail_unavailable` | Temporary Google, network or rate-limit failure. The grant stays active; retry later. |
