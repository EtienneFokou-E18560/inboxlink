# Host app integration (optional)

> **Slice J — optional, last in merge hierarchy.**  
> Merge only after connect + messages are proven and you explicitly want a host product path.  
> InboxLink core stays independent: **do not** import or depend on any specific host app (including career-workspace) from this repository.

This guide is for **any** host application that wants to connect a user’s mailbox via InboxLink. It covers the Link-style flow that already ships in v0:

1. Create a link session  
2. Redirect the user to Connect  
3. Exchange the one-time `public_token` for a durable `grantId`  
4. (Optional) Call the messages API with that grant  

Copyable curl and TypeScript sketches live under [`examples/host-integration/`](../examples/host-integration/).

---

## Prerequisites

| Host needs | Notes |
|------------|--------|
| InboxLink base URL | e.g. `https://inboxlink-two.vercel.app` or `http://localhost:8787` |
| API secret | `INBOXLINK_API_SECRET` — required when the server runs `INBOXLINK_MODE=multi`. In `single` mode the Bearer check is skipped, but sending the header is still fine. |
| A redirect URI you control | HTTPS in production. InboxLink will append `public_token` and `link_token` query params after OAuth. |

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

### 1. Create a link session

`POST /v1/link/sessions`

```http
POST /v1/link/sessions HTTP/1.1
Host: <inboxlink-base>
Authorization: Bearer <INBOXLINK_API_SECRET>
Content-Type: application/json

{
  "externalUserId": "<your-stable-user-id>",
  "redirectUri": "https://your-app.example/inboxlink/done",
  "products": ["messages"]
}
```

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
- `redirectUri` — must be a URL your host can handle. Do not point it at InboxLink.
- `products` — optional; defaults to `["messages"]`.

With `@inboxlink/sdk`:

```ts
import { InboxLink } from "@inboxlink/sdk";

const il = new InboxLink({
  baseUrl: process.env.INBOXLINK_BASE_URL!,
  apiSecret: process.env.INBOXLINK_API_SECRET!,
});

const session = await il.link.createSession({
  externalUserId: user.id,
  redirectUri: "https://your-app.example/inboxlink/done",
});
// send session.connectUrl to the browser (redirect or open)
```

### 2. Redirect the user to Connect

Send the browser to `connectUrl` (full-page redirect or new tab). The Connect page starts provider OAuth. After success, InboxLink redirects to your `redirectUri` with:

| Query param     | Meaning |
|-----------------|---------|
| `public_token`  | One-time token for grant exchange (required) |
| `link_token`    | Original link token (optional correlation) |

Example landing URL:

```text
https://your-app.example/inboxlink/done?public_token=…&link_token=…
```

Handle this on the **server** (or a BFF route). Do not exchange the public token from untrusted client-only code if your API secret would be exposed.

On OAuth error, InboxLink shows an HTML error page instead of redirecting — your host redirect handler should treat a missing `public_token` as an incomplete connect.

### 3. Exchange `public_token` → `grantId`

`POST /v1/grants/exchange`

```http
POST /v1/grants/exchange HTTP/1.1
Authorization: Bearer <INBOXLINK_API_SECRET>
Content-Type: application/json

{ "publicToken": "<from query string>" }
```

Response:

```json
{ "grantId": "grant_…" }
```

The public token is **consumed once**. Persist `grantId` (and optionally the mailbox email from `GET /v1/grants`) against your user. Later calls use `grantId` only.

SDK:

```ts
const { grantId } = await il.grants.exchange({ publicToken });
await db.saveInboxGrant(user.id, grantId);
```

### 4. Use the grant (messages)

```http
GET /v1/grants/<grantId>/messages?limit=25
Authorization: Bearer <INBOXLINK_API_SECRET>
```

Or list grants for a user:

```http
GET /v1/grants?externalUserId=<your-stable-user-id>
Authorization: Bearer <INBOXLINK_API_SECRET>
```

Revoke (deletes vault ciphertext + grant):

```http
DELETE /v1/grants/<grantId>
Authorization: Bearer <INBOXLINK_API_SECRET>
```

---

## Auth modes

| `INBOXLINK_MODE` | Host Bearer required? |
|------------------|------------------------|
| `single` (default) | No — routes trust the single deployment |
| `multi` | Yes — `Authorization: Bearer <INBOXLINK_API_SECRET>` |

Always send the Bearer header in production host code so flipping to `multi` does not break you.

OAuth callback (`/v1/oauth/…`) and Connect (`/v1/connect/…`) stay public; they are bound by session state, not the API secret.

---

## Optional: webhooks / events (not delivered yet)

v0 prepares webhook **verification** but does **not** POST events to hosts yet.

What exists today:

- Env placeholder `INBOXLINK_WEBHOOK_SECRET` (see `.env.example`)
- Tenant column `webhook_secret` in the schema stub
- SDK helper `InboxLink.webhooks.verify({ payload, signatureHeader, secret })` — HMAC-SHA256 over the raw body; header form `sha256=<hex>`

When delivery lands, expect something like:

1. InboxLink `POST`s a JSON body to a URL you register.  
2. Header `X-InboxLink-Signature: sha256=<hex>` (name may be finalized with the delivery PR).  
3. Your handler verifies with the shared secret, then reacts to event types such as `grant.created`, `grant.revoked`, or `grant.needs_reauth`.

Until then, poll `GET /v1/grants` / session status, or rely on the redirect + exchange path above. Do not invent a webhook receiver contract that this repo does not implement.

Verify sketch (future-proof):

```ts
const ok = il.webhooks.verify({
  payload: rawBodyString,
  signatureHeader: req.headers.get("x-inboxlink-signature") ?? "",
  secret: process.env.INBOXLINK_WEBHOOK_SECRET!,
});
if (!ok) return new Response("invalid signature", { status: 401 });
```

---

## Host checklist

- [ ] Store only `grantId` (+ your `externalUserId` mapping), never refresh tokens  
- [ ] Exchange `public_token` server-side, once  
- [ ] Handle missing/invalid token on the redirect route  
- [ ] Handle `needs_reauth` / `grant_inactive` from messages by sending the user through Connect again  
- [ ] Keep API and webhook secrets out of the browser bundle  
- [ ] Do **not** add a dependency from InboxLink → your host app (or career-workspace)

---

## Related

- Minimal SDK demo: [`apps/demo`](../apps/demo)  
- Runnable sketches: [`examples/host-integration`](../examples/host-integration)  
- Server routes: `packages/server/src/routes/app.ts`  
- SDK: `packages/sdk/src/index.ts`
