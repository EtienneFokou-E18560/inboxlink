import { InboxLink } from "@inboxlink/sdk";

/**
 * Minimal host-app demo.
 *
 * Against Production (default): `pnpm --filter @inboxlink/demo start`
 * Against local server: start `pnpm --filter @inboxlink/server dev`, then
 *   INBOXLINK_BASE_URL=http://localhost:8787 pnpm --filter @inboxlink/demo start
 */
async function main() {
  const baseUrl = process.env.INBOXLINK_BASE_URL?.trim() || undefined;
  const apiSecret = process.env.INBOXLINK_API_SECRET?.trim() || undefined;
  const redirectUri = process.env.REDIRECT_URI ?? "http://127.0.0.1:9999/done";

  const il = new InboxLink({
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiSecret ? { apiSecret } : {}),
  });

  const session = await il.createConnectSession({
    externalUserId: "demo-user-1",
    redirectUri,
  });

  console.log("baseUrl:", il.baseUrl);
  console.log("Open this Connect URL in a browser:");
  console.log(session.connectUrl);
  console.log(
    "\nAfter OAuth: il.completeConnect({ publicToken }) → il.messages.list / get, il.grants.sync.",
  );
  console.log("Hosts never set GOOGLE_* — OAuth stays on the InboxLink server.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
