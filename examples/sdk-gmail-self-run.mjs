#!/usr/bin/env node
/**
 * Gmail-focused @inboxlink/sdk self-run against a known grant.
 *
 * Prefer this over session create when you already have a grantId.
 * Runs from the monorepo (file path to packages/sdk) — no npm publish required.
 *
 *   pnpm --filter @inboxlink/core --filter @inboxlink/sdk build
 *   export INBOXLINK_BASE_URL=https://inboxlink-two.vercel.app
 *   export GRANT_ID=grant_…
 *   # Production is single-mode; any non-empty secret is fine for the SDK header:
 *   export INBOXLINK_API_SECRET=unused-in-single-mode
 *   node examples/sdk-gmail-self-run.mjs
 *
 * Never log refresh tokens or public_tokens. This script prints body *lengths* only.
 */
import { InboxLink, InboxLinkApiError } from "../packages/sdk/dist/index.js";

const baseUrl = process.env.INBOXLINK_BASE_URL ?? "https://inboxlink-two.vercel.app";
const apiSecret = process.env.INBOXLINK_API_SECRET ?? "unused-in-single-mode";
const grantId = process.env.GRANT_ID;

if (!grantId?.trim()) {
  console.error("FAIL: set GRANT_ID to an active Gmail grant id");
  process.exit(1);
}

const il = new InboxLink({ baseUrl, apiSecret });

function bodySummary(message) {
  const text = message.body?.text ?? "";
  const html = message.body?.html ?? "";
  return {
    hasBody: Boolean(message.body),
    textLen: text.length,
    htmlLen: html.length,
    complete: text.length > 0 || html.length > 0,
    snippetLen: (message.snippet ?? "").length,
    attachmentMeta: (message.attachments ?? []).length,
  };
}

const results = { list: "fail", get: "fail", sync: "fail", completeBodies: false };

try {
  console.log("target:", baseUrl);
  console.log("grantId:", grantId);
  console.log("(Node SDK → no browser CORS)");

  const page = await il.messages.list(grantId, { limit: 3 });
  console.log("list: ok", {
    count: page.messages.length,
    nextCursor: Boolean(page.nextCursor),
  });
  for (const m of page.messages) {
    console.log("  list-item", {
      id: m.id,
      subject: (m.subject ?? "").slice(0, 48),
      ...bodySummary(m),
    });
  }
  results.list = "pass";

  const first = page.messages[0];
  if (!first) {
    console.error("FAIL: list returned zero messages");
    process.exit(1);
  }

  const { message } = await il.messages.get(grantId, first.id);
  const summary = bodySummary(message);
  console.log("get: ok", {
    id: message.id,
    subject: (message.subject ?? "").slice(0, 48),
    ...summary,
  });
  results.get = "pass";
  results.completeBodies = summary.complete;

  if (!summary.complete) {
    console.error("FAIL: get-by-id missing body.text and body.html (snippet-only?)");
    process.exit(1);
  }

  const sync = await il.grants.sync(grantId);
  console.log("sync: ok", {
    status: sync.status,
    mode: sync.mode,
    upserted: sync.upserted,
    deleted: sync.deleted,
    historyId: Boolean(sync.historyId),
  });
  results.sync = sync.status === "ok" ? "pass" : "fail";
  if (results.sync !== "pass") {
    console.error("FAIL: sync status", sync.status);
    process.exit(1);
  }

  console.log("SUMMARY", results);
  console.log("PASS: list + get (complete body) + sync");
} catch (err) {
  if (err instanceof InboxLinkApiError) {
    console.error("API error", { status: err.status, method: err.method, path: err.path });
    console.error(err.body.slice(0, 300));
  } else {
    console.error(err);
  }
  console.log("SUMMARY", results);
  process.exit(1);
}
