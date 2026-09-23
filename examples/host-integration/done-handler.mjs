#!/usr/bin/env node
/**
 * Host redirect / exchange sketch.
 *
 * Usage:
 *   node done-handler.mjs --public-token <token>
 *   node done-handler.mjs --url 'http://127.0.0.1:9999/done?public_token=…&link_token=…'
 *
 * Env (host-only):
 *   INBOXLINK_BASE_URL      optional — defaults to Production via SDK
 *   INBOXLINK_API_SECRET    optional — only for multi mode
 */
import {
  InboxLink,
  parseConnectRedirect,
} from "../../packages/sdk/dist/index.js";

const baseUrl = process.env.INBOXLINK_BASE_URL?.trim() || undefined;
const apiSecret = process.env.INBOXLINK_API_SECRET?.trim() || undefined;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function publicTokenFromArgs() {
  const direct = arg("--public-token");
  if (direct) return direct;
  const url = arg("--url");
  if (!url) return undefined;
  return parseConnectRedirect(url).publicToken;
}

async function main() {
  let publicToken;
  try {
    publicToken = publicTokenFromArgs();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (!publicToken) {
    console.error("Pass --public-token <token> or --url <redirect-url-with-query>");
    process.exit(1);
  }

  const il = new InboxLink({
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiSecret ? { apiSecret } : {}),
  });

  const { grantId } = await il.completeConnect({ publicToken });
  console.log("grantId:", grantId);
  console.log("baseUrl:", il.baseUrl);

  if (process.argv.includes("--list-messages")) {
    const page = await il.messages.list(grantId, { limit: 5 });
    console.log("messages:", page.messages?.length ?? 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
