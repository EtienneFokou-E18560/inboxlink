---
title: Sync and webhooks
description: Keep the message cache fresh and get signed events when mail arrives or a grant changes.
---

## Sync jobs

```ts
const { jobId } = await il.grants.sync(grantId); // HTTP 202, status "queued"
const job = await il.grants.getSyncJob(grantId, jobId); // "completed" or "failed"
```

The first sync of a grant takes its one look back: the newest inbox messages
(up to 50) received inside the time limit. Later syncs apply Gmail history since
the last sync and read new mail only. A grant gets that first look once:
`{ mode: "full" }` (`il.grants.sync(grantId, { mode: "full" })`) only does it for
a grant that never had it, and otherwise runs as an incremental sync. If Gmail no
longer knows the last watermark, the sync restarts from the mailbox's current
state without looking back.

What the cache keeps (since 0.3.0):

- **Inbox mail only.** Mail without the `INBOX` label, and anything labelled
  `SENT`, `DRAFT`, `SPAM` or `TRASH`, is not cached. A cached message that leaves
  the inbox (archived, trashed) is removed at the next sync. One restored from
  the trash or spam is cached again at the next sync.
- **Metadata only.** Ids, thread, `receivedAt`, labels, subject and snippet. No
  bodies, addresses or attachment names. Subject and snippet are encrypted at
  rest. Sync reads messages with Gmail `format=metadata`, never in full.
- **A time limit.** Rows received more than `INBOXLINK_MESSAGE_TTL_DAYS` days
  ago (30 on the hosted service) are deleted at each sync of the grant and by
  the daily scheduled job. The job result carries `expired`: rows this sync
  deleted.
Jobs are drained by a scheduled job and right after you enqueue, so poll
`getSyncJob` or wait for `sync.completed`.

With Gmail push configured on the server, new mail is applied to the cache as
it arrives and you get `message.created`.

## Webhooks

Register an endpoint for your tenant. The signing secret is returned **once**:
store it in your secret manager.

```bash
curl -X POST "$BASE/v1/webhooks" -H "Authorization: Bearer $API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-app.example.com/api/inboxlink/webhook","events":["message.created","sync.completed"]}'
```

`GET /v1/webhooks` lists your endpoints (without secrets) and
`DELETE /v1/webhooks/:id` removes one. An endpoint registered without
`events` receives every event type, including ones added later, so ignore
types you do not handle.

| Event | When |
|---|---|
| `grant.connected` | A Connect finished and the grant is stored |
| `grant.needs_reauth` | Google refused the grant's token |
| `grant.revoked` | A Connect took the mailbox away from `externalUserId` (`reason`: `replaced` or `reassigned`) |
| `sync.completed` | A sync job finished |
| `message.created` | Gmail push added a new inbox message. Identifiers only: `grantId`, `messageId`, `providerMessageId`, `threadId`, `receivedAt` (no subject since 0.3.0); call `messages.get` for the content |

Delivery is at least once, with retries on 408, 429 and 5xx.

### Verify the signature

Each POST carries `X-InboxLink-Signature: sha256=<hex>`, an HMAC-SHA256 of the
raw body. Verify before parsing:

```ts
const rawBody = await request.text(); // the exact bytes
const ok = il.webhooks.verify({
  payload: rawBody,
  signatureHeader: request.headers.get("x-inboxlink-signature") ?? "",
  secret: process.env.INBOXLINK_WEBHOOK_SECRET!,
});
if (!ok) return new Response("invalid signature", { status: 401 });
const event = JSON.parse(rawBody);
```

```json
{
  "id": "evt_…",
  "type": "grant.connected",
  "createdAt": "2026-09-25T00:00:00.000Z",
  "data": { "grantId": "grant_…", "externalUserId": "user-1", "provider": "gmail" }
}
```
