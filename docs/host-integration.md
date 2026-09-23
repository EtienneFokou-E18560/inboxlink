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
| API secret | Host **only if** server is `multi` | Production is currently `single` — omit `apiSecret`. |
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

// Production + single mode: zero config
const il = new InboxLink();

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
Content-Type: application/json

{
  "externalUserId": "<your-stable-user-id>",
  "redirectUri": "https://your-app.example.com/inboxlink/done",
  "products": ["messages"]
}
```

In `multi` mode, also send `Authorization: Bearer <INBOXLINK_API_SECRET>`.

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
  - Shared Production is permissive by default. Self-hosts / tightened Production may set `ALLOWED_REDIRECT_ORIGINS` (comma-separated origins like `https://your-app.example.com`); then your `redirectUri` origin must match or session create returns `redirectUri_not_allowed`.
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
const page = await il.messages.list(grantId, {
  limit: 25,
  q: "is:unread newer_than:7d",
  label: ["INBOX"],
  from: "ada@example.com",
});
const { message } = await il.messages.get(grantId, page.messages[0]!.id);
await il.grants.sync(grantId);
```

List filters (all optional): `q` (Gmail search), `from` / `to` / `subject` (composed into `q`), `label` (→ Gmail `labelIds`), `includeSpamTrash`. Same params work on the HTTP API as query strings (`label` may be repeated).

Or list grants for a user: `il.grants.list(externalUserId)`. Revoke: `il.grants.revoke(grantId)`.

---

## Auth modes

| `INBOXLINK_MODE` | Host Bearer required? |
|------------------|------------------------|
| `single` (default / current Production) | No — omit `apiSecret` |
| `multi` | Yes — `new InboxLink({ apiSecret: "…" })` |

OAuth callback (`/v1/oauth/…`) and Connect (`/v1/connect/…`) stay public; they are bound by session state, not the API secret.

---

## Optional: webhooks / events (not delivered yet)

v0 prepares webhook **verification** but does **not** POST events to hosts yet.

What exists today:

- Env placeholder `INBOXLINK_WEBHOOK_SECRET` (server `.env.example`)
- Tenant column `webhook_secret` in the schema stub
- SDK helper `InboxLink.webhooks.verify({ payload, signatureHeader, secret })` — HMAC-SHA256 over the raw body; header form `sha256=<hex>`

Until delivery lands, poll `GET /v1/grants` / rely on redirect + exchange. Do not invent a webhook receiver contract that this repo does not implement.

---

## Host checklist

- [ ] Install SDK (npm when published; otherwise workspace / git dependency)  
- [ ] `new InboxLink()` against Production, or pass `baseUrl` for local  
- [ ] Implement **one** host redirect route that calls `completeConnect`  
- [ ] Store only `grantId` (+ your `externalUserId` mapping), never refresh tokens  
- [ ] Exchange `public_token` server-side, once  
- [ ] Handle missing/invalid token on the redirect route  
- [ ] Handle `needs_reauth` / `grant_inactive` from messages by sending the user through Connect again  
- [ ] Keep API secrets out of the browser bundle  
- [ ] Do **not** set `GOOGLE_*`, Postgres, or vault keys in the host app  
- [ ] Do **not** add a dependency from InboxLink → your host app (or career-workspace)

---

## Related

- Minimal SDK demo: [`apps/demo`](../apps/demo)  
- Runnable sketches: [`examples/host-integration`](../examples/host-integration)  
- Server routes: `packages/server/src/routes/app.ts`  
- SDK: `packages/sdk/src/index.ts` / [`packages/sdk/README.md`](../packages/sdk/README.md)
