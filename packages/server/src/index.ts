import { serve } from "@hono/node-server";
import { handle as handleNode } from "@hono/node-server/vercel";
import { handle as handleWeb } from "hono/vercel";
import { GmailAdapter } from "@inboxlink/adapters-gmail";
import { ImapAdapter } from "@inboxlink/adapters-imap";
import { loadConfig } from "./config.js";
import { createApp } from "./routes/app.js";
import type { QueueHandle } from "./queue/sync-queue.js";
import { createSyncQueue } from "./queue/sync-queue.js";
import { PgDatabase, PostgresStore, PostgresTokenVault } from "./db/postgres-store.js";
import { createPostgresClient, PostgresJsExecutor } from "./db/sql.js";
import type { GrantStore } from "./store.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

type AppBundle = {
  app: ReturnType<typeof createApp>;
  config: ReturnType<typeof loadConfig>;
  store: GrantStore;
  vault: MemoryTokenVault | PostgresTokenVault;
  storeKind: "memory" | "postgres";
};

const postgresByUrl = new Map<string, { db: PgDatabase; store: PostgresStore }>();

/** Build the Hono app from env (no listen). Used by Node CLI and Vercel. */
export function createAppFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  queue: QueueHandle | null = null,
): AppBundle {
  const config = loadConfig(env);
  const databaseUrl = config.databaseUrl?.trim();
  const opened = databaseUrl ? openPostgres(databaseUrl) : undefined;
  const store = opened?.store ?? new MemoryStore();
  const vault = opened
    ? new PostgresTokenVault(opened.db, config.masterKey)
    : new MemoryTokenVault(config.masterKey);
  const storeKind = opened ? "postgres" : "memory";
  const gmail = new GmailAdapter({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
  });
  const imap = new ImapAdapter();
  const app = createApp({
    store,
    vault,
    gmail,
    imap,
    publicBaseUrl: config.publicBaseUrl,
    apiSecret: config.apiSecret,
    mode: config.mode,
    gmailScopes: config.gmailScopes,
    oauthRedirectUri: config.googleRedirectUri,
    storeKind,
    queue,
  });
  return { app, config, store, vault, storeKind };
}

function openPostgres(databaseUrl: string): { db: PgDatabase; store: PostgresStore } {
  const existing = postgresByUrl.get(databaseUrl);
  if (existing) return existing;
  const db = new PgDatabase(new PostgresJsExecutor(createPostgresClient(databaseUrl)));
  const created = { db, store: new PostgresStore(db) };
  postgresByUrl.set(databaseUrl, created);
  return created;
}

/**
 * Vercel Node invokes the default export with either a Web Request or the
 * Node (req, res) pair. `hono/vercel` only returns a Response, which the
 * Node listener ignores, so the request hangs. Write the Node response when
 * that is the runtime shape.
 */
export function createVercelHandler(env: NodeJS.ProcessEnv = process.env) {
  const { app } = createAppFromEnv(env);
  const web = handleWeb(app);
  const node = handleNode(app);
  return (incoming: unknown, outgoing?: unknown) => {
    if (typeof Request !== "undefined" && incoming instanceof Request) {
      return web(incoming);
    }
    return node(
      incoming as Parameters<typeof node>[0],
      outgoing as Parameters<typeof node>[1],
    );
  };
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

export { createApp, loadConfig, MemoryStore, MemoryTokenVault, PostgresStore, PostgresTokenVault };
