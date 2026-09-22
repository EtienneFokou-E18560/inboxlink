import { serve } from "@hono/node-server";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { loadConfig } from "./config.js";
import { createApp } from "./routes/app.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";
import { createSyncQueue } from "./queue/sync-queue.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const store = new MemoryStore();
  const vault = new MemoryTokenVault(config.masterKey);
  const gmail = new GmailAdapter({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  });
  const queue = await createSyncQueue(config.redisUrl);
  const app = createApp({
    store,
    vault,
    gmail,
    publicBaseUrl: config.publicBaseUrl,
    apiSecret: config.apiSecret,
    mode: config.mode,
    gmailScopes: config.gmailScopes,
    queue,
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    console.info(
      `[inboxlink] listening on http://${config.host}:${config.port} (mode=${config.mode})`,
    );
    console.info(`[inboxlink] health: ${config.publicBaseUrl}/health`);
  });

  return { app, server, config, queue };
}

export { createApp, loadConfig, MemoryStore, MemoryTokenVault };
