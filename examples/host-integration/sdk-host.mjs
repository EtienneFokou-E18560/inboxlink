#!/usr/bin/env node
/**
 * Same host flow using @inboxlink/sdk (run from the InboxLink monorepo).
 *
 *   pnpm --filter @inboxlink/core --filter @inboxlink/sdk build
 *   node examples/host-integration/sdk-host.mjs
 *
 * Defaults to Production (no baseUrl / apiSecret). Override with env for local.
 * Does not import any product host (career-workspace or otherwise).
 */
import {
  InboxLink,
  INBOXLINK_PRODUCTION_URL,
} from "../../packages/sdk/dist/index.js";

const baseUrl = process.env.INBOXLINK_BASE_URL?.trim() || undefined;
const apiSecret = process.env.INBOXLINK_API_SECRET?.trim() || undefined;
const externalUserId = process.env.EXTERNAL_USER_ID ?? "host-user-1";
const redirectUri = process.env.REDIRECT_URI ?? "http://127.0.0.1:9999/done";

const il = new InboxLink({
  ...(baseUrl ? { baseUrl } : {}),
  ...(apiSecret ? { apiSecret } : {}),
});

const session = await il.createConnectSession({
  externalUserId,
  redirectUri,
  products: ["messages"],
});

console.log("baseUrl:", il.baseUrl);
console.log("sessionId:", session.sessionId);
console.log("Open connectUrl in a browser:");
console.log(session.connectUrl);
console.log("");
console.log("After redirect, finish with:");
console.log("  await il.completeConnect({ redirectUrl })  // or { publicToken }");
console.log("");
console.log(
  `Defaults: Production=${INBOXLINK_PRODUCTION_URL}; set INBOXLINK_BASE_URL for local.`,
);
console.log("Hosts never set GOOGLE_* — OAuth stays on the InboxLink server.");
