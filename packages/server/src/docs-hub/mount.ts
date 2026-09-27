import type { Hono } from "hono";
import {
  renderDocsHubPage,
  type DocsHubOptions,
} from "@inboxlink/connect-ui";

export type MountDocsHubOptions = DocsHubOptions;

/**
 * Registers public docs hub routes. Isolated from landing/status so parallel
 * MVP slices can land without fighting over the same module.
 * HTML lives in `@inboxlink/connect-ui` `public/` (shared document helper).
 */
export function mountDocsHub<E extends object>(
  app: Hono<E>,
  opts: MountDocsHubOptions = {},
): void {
  app.get("/docs", (c) => c.html(renderDocsHubPage(opts)));
  app.get("/docs/", (c) => c.html(renderDocsHubPage(opts)));
}
