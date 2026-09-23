#!/usr/bin/env node
/**
 * Same host flow using @inboxlink/sdk (run from the InboxLink monorepo).
 *
 *   pnpm build
 *   node examples/host-integration/sdk-host.mjs
 *
 * Does not import any product host (career-workspace or otherwise).
 * Uses a relative path so this file works without a separate package.json.
 */
import { InboxLink } from "../../packages/sdk/dist/index.js";

const baseUrl = process.env.INBOXLINK_BASE_URL ?? "http://localhost:8787";
const apiSecret = process.env.INBOXLINK_API_SECRET ?? "dev-api-secret-change-me";
const externalUserId = process.env.EXTERNAL_USER_ID ?? "host-user-1";
const redirectUri = process.env.REDIRECT_URI ?? "http://127.0.0.1:9999/done";

const il = new InboxLink({ baseUrl, apiSecret });

const session = await il.link.createSession({
  externalUserId,
  redirectUri,
  products: ["messages"],
});

console.log("sessionId:", session.sessionId);
console.log("Open connectUrl in a browser:");
console.log(session.connectUrl);
console.log("");
console.log("After redirect, exchange with:");
console.log("  await il.grants.exchange({ publicToken })");
console.log("");
console.log("Webhook delivery is not implemented yet; signature verify helper:");
console.log("  il.webhooks.verify({ payload, signatureHeader, secret })");
