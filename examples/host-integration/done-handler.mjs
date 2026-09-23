#!/usr/bin/env node
/**
 * Host redirect / exchange sketch (plain fetch — no host-app imports).
 *
 * Usage:
 *   node done-handler.mjs --public-token <token>
 *   node done-handler.mjs --url 'http://127.0.0.1:9999/done?public_token=…&link_token=…'
 *
 * Env:
 *   INBOXLINK_BASE_URL      default http://localhost:8787
 *   INBOXLINK_API_SECRET    default dev-api-secret-change-me
 */
const baseUrl = (process.env.INBOXLINK_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const apiSecret = process.env.INBOXLINK_API_SECRET ?? "dev-api-secret-change-me";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function publicTokenFromArgs() {
  const direct = arg("--public-token");
  if (direct) return direct;
  const url = arg("--url");
  if (!url) return undefined;
  return new URL(url).searchParams.get("public_token") ?? undefined;
}

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiSecret}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function main() {
  const publicToken = publicTokenFromArgs();
  if (!publicToken) {
    console.error("Pass --public-token <token> or --url <redirect-url-with-query>");
    process.exit(1);
  }

  const { grantId } = await request("POST", "/v1/grants/exchange", { publicToken });
  console.log("grantId:", grantId);

  // Optional: prove the grant works (needs a live Gmail grant + vault).
  if (process.argv.includes("--list-messages")) {
    const page = await request("GET", `/v1/grants/${encodeURIComponent(grantId)}/messages?limit=5`);
    console.log("messages:", page.messages?.length ?? 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
