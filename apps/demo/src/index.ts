import { InboxLink } from "@inboxlink/sdk";

/**
 * Minimal host-app demo.
 * Start the server first: `pnpm --filter @inboxlink/server dev`
 * Then: `pnpm --filter @inboxlink/demo start`
 */
async function main() {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
  const apiSecret = process.env.INBOXLINK_API_SECRET ?? "dev-api-secret-change-me";

  const il = new InboxLink({ baseUrl, apiSecret });
  const session = await il.link.createSession({
    externalUserId: "demo-user-1",
    redirectUri: "http://localhost:9999/oauth-done",
  });

  console.log("Open this Connect URL in a browser:");
  console.log(session.connectUrl);
  console.log(
    "\nAfter OAuth (or stub exchange), exchange public_token via il.grants.exchange().",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
