# Host app integration (optional)

> InboxLink core stays independent: **do not** import or depend on any specific host app (including career-workspace) from this repository.

This guide is for **any** host application that wants to connect a user’s Gmail mailbox via InboxLink:

1. Create a Connect session (`createConnectSession`)  
2. Redirect the user to `connectUrl`  
3. Exchange the one-time `public_token` for a durable `grantId` (`completeConnect`)  
4. Call the messages API with that grant  

Copyable curl and TypeScript sketches live under [`examples/host-integration/`](../examples/host-integration/).

---

## What the host configures (vs InboxLink)

| Concern | Who | Notes |
|---------|-----|--------|
| Google OAuth (`GOOGLE_CLIENT_ID` / `SECRET` / redirect) | **InboxLink server only** | Hosts **never** register a Google client or set `GOOGLE_*`. |
| Postgres / vault / `INBOXLINK_MASTER_KEY` | **InboxLink server only** | Production already has these. |
| InboxLink base URL | Host (optional) | SDK defaults to Production `https://inboxlink-two.vercel.app`. Override for local/self-host. |
| API secret | Host (Production / any `multi` server) | Production runs `INBOXLINK_MODE=multi`. Set `INBOXLINK_API_SECRET` and pass SDK `apiSecret`. Never ship the secret to browsers. |
| Host redirect URI | Host | Your callback that receives `?public_token=…` (not the Google OAuth callback). |

Minimal host env: [`examples/host-integration/host.env.example`](../examples/host-integration/host.env.example).

The host **never** receives Gmail refresh tokens. Only InboxLink’s vault holds them.

---

## End-to-end flow

```text
Host backend                    InboxLink                         User browser
     |                               |                                  |
     |-- POST /v1/link/sessions ---->|                                  |
     |<-- { connectUrl, ... } -------|                                  |
     |-- 302/redirect user to connectUrl ------------------------------>|
     |                               |<-- Connect + Gmail OAuth --------|
     |                               |-- 302 to host redirectUri ------>|
     |<-- GET redirect?public_token=… ----------------------------------|
     |-- POST /v1/grants/exchange -->|                                  |
     |<-- { grantId } ---------------|                                  |
     |-- store grantId for user -----|                                  |
```

### 1. Create a Connect session

With `@inboxlink/sdk` (recommended):

```ts
import { InboxLink } from "@inboxlink/sdk";

// Production is multi — apiSecret required (server-side only; never in browsers)
const il = new InboxLink({
  apiSecret: process.env.INBOXLINK_API_SECRET,
});

const session = await il.createConnectSession({
  externalUserId: user.id,
  redirectUri: "https://your-app.example.com/inboxlink/done", // YOUR host URL
});
// send session.connectUrl to the browser (redirect or open)
```

`POST /v1/link/sessions` (raw HTTP):

```http
POST /v1/link/sessions HTTP/1.1
Host: inboxlink-two.vercel.app
Authorization: Bearer <INBOXLINK_API_SECRET>
Content-Type: application/json

{
  "externalUserId": "<your-stable-user-id>",
  "redirectUri": "https://your-app.example.com/inboxlink/done",
  "products": ["messages"]
}
```

Unauthenticated session create against Production returns `401`. `GET /health` stays public (expect `"mode":"multi"`, `"store":"postgres"`).

Response (shape):

```json
{
  "sessionId": "sess_…",
  "linkToken": "…",
  "connectUrl": "https://…/v1/connect/<linkToken>",
  "expiresAt": "…"
}
```

- `externalUserId` — opaque id in **your** user namespace. InboxLink stores it on the grant; use it later for `GET /v1/grants?externalUserId=…`.
- `redirectUri` — must be a URL **your host** can handle. Do not point it at InboxLink, and do not confuse it with Google’s OAuth redirect (that stays on InboxLink).
  - Shared Production redirects are permissive by default. Self-hosts / tightened Production may set `ALLOWED_REDIRECT_ORIGINS` (comma-separated origins like `https://your-app.example.com`); then your `redirectUri` origin must match or session create returns `redirectUri_not_allowed`. The same allowlist (plus the API’s own origin) drives browser CORS — unknown origins do not receive `Access-Control-Allow-Origin`.
- `products` — optional; defaults to `["messages"]`.

### 2. Redirect the user to Connect

Send the browser to `connectUrl` (full-page redirect or new tab). The Connect page starts Gmail OAuth on InboxLink. After success, InboxLink redirects to your `redirectUri` with:

| Query param     | Meaning |
|-----------------|---------|
| `public_token`  | One-time token for grant exchange (required) |
| `link_token`    | Original link token (optional correlation) |

Example landing URL:

```text
https://your-app.example.com/inboxlink/done?public_token=…&link_token=…
```

Handle this on the **server** (or a BFF route). Do not exchange the public token from untrusted client-only code if your API secret would be exposed.

On OAuth error, InboxLink shows an HTML error page instead of redirecting — your host redirect handler should treat a missing `public_token` as an incomplete connect (`parseConnectRedirect` throws a clear error in that case).

**Start again.** When Google returns with an OAuth `state` that no longer matches a live session (the link was used already, or the session expired while the user was at Google), the error page offers a **Start again** button if InboxLink knows your `redirectUri` (from the session, or from a cookie set on the Connect page). The button sends the browser to your `redirectUri` with `error=connect_restart` (your own query parameters are kept). Handle it by creating a new link session and redirecting to its `connectUrl`; a host that ignores it should at least show a "connect again" prompt. The page never consumes or changes a session.

### 3. Exchange `public_token` → `grantId`

SDK:

```ts
const { grantId } = await il.completeConnect({ redirectUrl: request.url });
// or: await il.completeConnect({ publicToken });
await db.saveInboxGrant(user.id, grantId);
```

Raw HTTP: `POST /v1/grants/exchange` with `{ "publicToken": "…" }` → `{ "grantId": "grant_…" }`.

The public token is **consumed once**. Persist `grantId` against your user. Later calls use `grantId` only.

### 4. Use the grant (messages)

```ts
await il.grants.sync(grantId); // enqueue (202 + jobId); poll getSyncJob or wait for webhook
const page = await il.messages.list(grantId, { limit: 25 });
// page.syncedAt / page.historyId reflect last sync cursor when source=store
const live = await il.messages.list(grantId, {
  source: "live",
  limit: 25,
  q: "is:unread newer_than:7d",
  label: ["INBOX"],
  from: "ada@example.com",
});
const { message } = await il.messages.get(grantId, page.messages[0]!.id);
void live;
```

Default list reads the **synced store**. Pass `source: "live"` for live Gmail + filters: `q`, `from` / `to` / `subject`, `label`, `includeSpamTrash`. Same params work on the HTTP API as query strings (`label` may be repeated). Call `messages.get` for body and attachment metadata.

Or list grants for a user: `il.grants.list(externalUserId)`. Revoke: `il.grants.revoke(grantId)`.

To list **every** grant of your tenant (for example to find grants whose user no longer exists on your side), use `il.grants.listAll({ limit, cursor })` or `for await (const g of il.grants.iterateAll())` (`GET /v1/grants?all=true`, oldest first, `limit` 1–200, default 50, `nextCursor` while there are more). Each entry has `id`, `externalUserId`, `provider`, `status`, `createdAt`, `updatedAt`, `lastSyncAt` (end of the last finished sync, when there was one) and `replaced` when it was retired. No address and no token are returned.

### Naming the owner on grant calls

Every call that names a grant accepts an optional `externalUserId` (query string `?externalUserId=`; SDK option `{ externalUserId }` on `messages.list`, `messages.iterate`, `messages.get`, `grants.sync`, `grants.getSyncJob`, `grants.revoke`). When the grant now belongs to another of your users (a reused grant, next section), the call answers **409 `{ "error": "grant_replaced" }`** and does nothing: a stale or deleted user cannot read, sync or delete a mailbox that moved to someone else. Send it on every call once your tenant uses `reuse`. Without it, calls behave as before.

### One mailbox, one live grant (identities)

InboxLink keys a grant to **your** `externalUserId`, but it treats the mailbox itself (tenant + provider + address, case ignored) as the thing that can only be connected once. What a finished Connect does with a live grant (`active` or `needs_reauth`) this tenant already has for the same address is a **per-tenant setting**, `INBOXLINK_CONNECT_POLICY` on the server (`tenantId=reuse`, comma or space separated). A tenant that is not listed keeps `replace`.

**`replace` (default).** The **new grant wins**:

- The new grant belongs to the `externalUserId` that just connected.
- Each earlier grant for that address (created before the new one) is retired inside InboxLink: its sealed token and cached messages are deleted and it becomes `revoked`. It still appears in `grants.list` for its old user with `"replaced": true`, so you can tell it apart from a grant you never had or one that was simply revoked (the new grant's id is not shown).
- Reads and syncs on a retired grant answer **409 `{ "error": "grant_replaced" }`** (other inactive grants still answer `grant_inactive`). Show "connected under another sign-in" or ask the user to reconnect; do not retry, and do not poll it.
- The old token is **not** revoked at Google: Google's revoke ends the whole authorization for that account, which would also kill the token that was just issued.
- Two Connects for the same address finishing at the same time (two tabs or devices) cannot retire each other: a Connect only retires grants older than its own, so the newest grant is the one that stays live. A sync that was already running on the retired grant cannot bring it back: a token refusal during that sync leaves it `revoked` (with `replaced: true`), and messages it fetches are not cached.

**`reuse`.** The **existing grant is kept**:

- **Same address** (Gmail only; the address Gmail's profile reports for the new token, not the sign-in address, so claiming another address is not enough; if the profile cannot be read, a new grant is made and the existing one is left as it is, cache included; the next Connect settles it): the fresh token is sealed on the existing grant, which keeps its `grantId` and its cached messages, goes back to `active`, and is now owned by the `externalUserId` that just connected. Only an incremental sync is queued, so nothing is fetched twice. If the tenant had several live grants for the address (made before this rule), the connecting user's own is kept (else the one named by `replacesGrantId`, else the newest) and the others are retired as under `replace`.
- If the grant belonged to another of your users, calls that name that user (`externalUserId`, above) answer **409 `grant_replaced`**, and `grants.list` for that user no longer shows it.
- Two Connects of one address finishing together both land on the same grant. Nothing is shared across tenants: each tenant keeps its own grant for the same address.

**Different address, either setting.** By default a Connect of another address **adds** a grant next to the user's existing ones. If your app asks the person whether to add the new mailbox or replace an existing one and they choose replace, pass that grant's id when you create the session: `il.link.createSession({ externalUserId, redirectUri, replacesGrantId })`. When they then connect a different address, that grant is retired (`revoked`, `replaced: true`, token and cache deleted). The grant must be the same user's live (not `revoked`) grant in your tenant, or the session is refused with 400 `invalid_replaces_grant`. IMAP Connects honour it too; a grant that moved to another user before Connect finished is left alone.

This covers the case where one person reaches your app under several identities: for example an anonymous id before sign-up (`anon_…`), a Google sign-in (`google:…`) and an email/password account (a uuid). InboxLink does not know these are the same person and does not link them; your app decides which identity a mailbox belongs to by which one runs Connect. If you merge identities on your side, move the `grantId` to the surviving user rather than connecting again, or connect again from the surviving user and let the rule above settle it.

A reconnect by the same user (the usual fix for `needs_reauth`) follows the same rule: under `replace` the old grant is retired, so store the new `grantId` and drop the old one; under `reuse` the `grantId` stays the same.

Whenever a Connect by one of your users takes a mailbox away from another of your users, InboxLink sends **`grant.revoked`** (below) for the user who lost it, under either setting. A user replacing their own grant gets no event: the Connect itself returns the new grant. It is a new event in 0.2.0: an endpoint registered without an `events` list receives it, so ignore event types you do not handle.

`needs_reauth` is set only when Google requires the person to connect again: Google refuses the refresh token (`invalid_grant`: revoked, expired, consent withdrawn), Gmail answers 401, or Gmail answers 403 naming a reason other than a rate limit or InboxLink's own setup. Any other failure (Google 5xx, the network, a rate limit) leaves the grant `active`; reads answer **502 `gmail_unavailable`** and the next sync retries. There is no time-based clean-up of `needs_reauth` grants.

To see whether a database already has mailboxes connected more than once (grants created before this rule), run `scripts/shared-address-report.sql` (see the ops runbook). It prints counts and grant ids, never addresses.

---

## Host webhooks (signed events)

When **both** `INBOXLINK_WEBHOOK_URL` and `INBOXLINK_WEBHOOK_SECRET` are set on the InboxLink server, the host receives POSTs for:

| Event | When |
|-------|------|
| `grant.connected` | OAuth Connect succeeds and a grant is vaulted |
| `grant.needs_reauth` | Google refuses the grant's token and it is marked `needs_reauth` |
| `grant.revoked` | A Connect took a mailbox away from `externalUserId`: `reason: "replaced"` (the grant was retired) or `"reassigned"` (the same grant now belongs to another of your users). Ask that user to reconnect, as for 409 `grant_replaced`. |
| `sync.completed` | Sync job completes successfully (API drain, cron, or Gmail push apply) |
| `message.created` | New message upserted from Gmail Pub/Sub push apply |

Delivery is at-least-once with bounded retries (retry on 408/429/5xx; drop on hard 4xx). Failures never break Connect redirects or sync HTTP responses.

### Async sync API

`POST /v1/grants/:id/sync` returns **202** `{ jobId, status: "queued" }`. Poll `GET /v1/grants/:id/sync/jobs/:jobId` (or `il.grants.getSyncJob`) for `completed` / `failed`. See [ops-runbook](./ops-runbook.md#async-sync-jobs-wave-d2).

### Payload + verify

```http
POST /your/webhook
Content-Type: application/json
X-InboxLink-Signature: sha256=<hex>
X-InboxLink-Event: grant.connected
```

```json
{
  "id": "evt_…",
  "type": "grant.connected",
  "createdAt": "2026-09-25T00:00:00.000Z",
  "data": {
    "grantId": "grant_…",
    "tenantId": "default",
    "externalUserId": "user-1",
    "provider": "gmail",
    "email": "user@gmail.com"
  }
}
```

Host verification (same secret as `INBOXLINK_WEBHOOK_SECRET`):

```ts
import { InboxLink } from "@inboxlink/sdk";

const il = new InboxLink({ apiSecret: process.env.INBOXLINK_API_SECRET });
const rawBody = await request.text(); // must be the exact raw bytes
const ok = il.webhooks.verify({
  payload: rawBody,
  signatureHeader: request.headers.get("x-inboxlink-signature") ?? "",
  secret: process.env.INBOXLINK_WEBHOOK_SECRET!,
});
```

Operators set URL + secret on the **InboxLink** service (see `.env.example`). Hosts only need the shared secret to verify — not Google / vault / Postgres env.

---

## Auth modes

| `INBOXLINK_MODE` | Host Bearer required? |
|------------------|------------------------|
| `multi` (current Production) | Yes — `INBOXLINK_API_SECRET` + `new InboxLink({ apiSecret })` |
| `single` (local / self-host default) | No — omit `apiSecret` |

OAuth callback (`/v1/oauth/…`) and Connect (`/v1/connect/…`) stay public; they are bound by session state, not the API secret. `GET /health` is public on every mode.

---

## Host checklist

- [ ] Install SDK (`npm i @inboxlink/sdk`, or workspace / git dependency)  
- [ ] Against Production: `new InboxLink({ apiSecret })` with `INBOXLINK_API_SECRET` (or pass `baseUrl` + secret for local `multi`)  
- [ ] Implement **one** host redirect route that calls `completeConnect`  
- [ ] Store only `grantId` (+ your `externalUserId` mapping), never refresh tokens  
- [ ] Exchange `public_token` server-side, once  
- [ ] Handle missing/invalid token on the redirect route  
- [ ] Handle `needs_reauth` / `grant_inactive` from messages by sending the user through Connect again  
- [ ] Handle `grant_replaced` and `grant.revoked`: the mailbox was connected again (maybe by another of your users); stop polling that `grantId` for that user and offer to reconnect  
- [ ] Under `reuse`, send `externalUserId` on every grant call  
- [ ] Optional: receive webhooks — set `INBOXLINK_WEBHOOK_URL` + `INBOXLINK_WEBHOOK_SECRET` on InboxLink; verify with `webhooks.verify`  
- [ ] Never ship `INBOXLINK_API_SECRET` / `apiSecret` to browsers  
- [ ] Do **not** set `GOOGLE_*`, Postgres, or vault keys in the host app  
- [ ] Do **not** add a dependency from InboxLink → your host app (or career-workspace)

---

## Related

- Minimal SDK demo: [`apps/demo`](../apps/demo)  
- Runnable sketches: [`examples/host-integration`](../examples/host-integration)  
- Server routes: `packages/server/src/routes/app.ts`  
- SDK: `packages/sdk/src/index.ts` / [`packages/sdk/README.md`](../packages/sdk/README.md)

## Per-tenant webhooks

Each tenant registers its own destinations; events for a tenant are delivered only to that tenant's endpoints.

```bash
# Register (secret is returned ONCE — store it in your secret manager)
curl -sS -X POST "$BASE/v1/webhooks" -H "Authorization: Bearer $TENANT_SECRET" \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-app.example.com/api/inboxlink/webhook","events":["message.created","sync.completed"]}'
curl -sS "$BASE/v1/webhooks" -H "Authorization: Bearer $TENANT_SECRET"        # list (no secrets)
curl -sS -X DELETE "$BASE/v1/webhooks/whe_…" -H "Authorization: Bearer $TENANT_SECRET"
```

- URLs must be public `https` (no credentials, no private/loopback/metadata hosts). Local `single` mode also allows `http://localhost`. Up to 5 endpoints per tenant. Omit `events` to receive all of: `grant.connected`, `grant.needs_reauth`, `grant.revoked`, `sync.completed`, `message.created`.
- Secrets are sealed with `INBOXLINK_MASTER_KEY`. Changing the master key makes existing endpoint secrets unreadable (deliveries to them are skipped) — delete and recreate them.
- Each delivery is a `POST` with headers `X-InboxLink-Timestamp` (unix seconds) and `X-InboxLink-Signature-V1` = `sha256=HMAC(secret, "<timestamp>.<raw body>")`. Reject requests more than ~5 minutes off. The legacy `X-InboxLink-Signature` (body-only HMAC) is still sent for older hosts but has no replay protection.
- Verify with the SDK: `il.webhooks.verifySigned({ payload, timestampHeader, signatureHeader, secret })`.
- Delivery: 5 s timeout per attempt, up to 3 attempts (retry on 408/429/5xx and network errors). Retries are in-process; a delivery that fails all attempts is **not** persisted. Treat webhooks as a hint and reconcile with `POST /v1/grants/:id/sync` or the messages API.
- The legacy `INBOXLINK_WEBHOOK_URL` / `INBOXLINK_WEBHOOK_SECRET` pair now applies to the default tenant only.
- Known limit: URL validation does not defend against DNS rebinding of a hostname that later resolves to a private address.
