import { serve } from "@hono/node-server";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { loadConfig } from "./config.js";
import { createApp } from "./routes/app.js";
import type { QueueHandle } from "./queue/sync-queue.js";
import { createSyncQueue } from "./queue/sync-queue.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

type AppBundle = {
  app: ReturnType<typeof createApp>;
  config: ReturnType<typeof loadConfig>;
  store: MemoryStore;
  vault: MemoryTokenVault;
};

/** Build the Hono app from env (no listen). Used by Node CLI and Vercel. */
export function createAppFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  queue: QueueHandle | null = null,
): AppBundle {
  const config = loadConfig(env);
  const store = new MemoryStore();
  const vault = new MemoryTokenVault(config.masterKey);
  const gmail = new GmailAdapter({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  });
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
  return { app, config, store, vault };
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const queue = await createSyncQueue(config.redisUrl);
  const { app } = createAppFromEnv(env, queue);

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    console.info(
      `[inboxlink] listening on http://${config.host}:${config.port} (mode=${config.mode})`,
    );
    console.info(`[inboxlink] health: ${config.publicBaseUrl}/health`);
  });

  return { app, server, config, queue };
}

export { createApp, loadConfig, MemoryStore, MemoryTokenVault };
