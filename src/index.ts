import { Hono } from "hono";
import { createAppFromEnv } from "@inboxlink/server";

/**
 * Entry for Vercel’s Hono preset. The builder only accepts app/index/server
 * files (including src/index.ts) that import "hono" and default-export the app.
 * `pnpm build` emits workspace packages before this file is bundled.
 */
const { app } = createAppFromEnv();

if (typeof Hono !== "function") {
  throw new Error("Hono runtime failed to load");
}

export default app;
