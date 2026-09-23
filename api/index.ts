import { handle } from "hono/vercel";
import { createAppFromEnv } from "@inboxlink/server";

export const runtime = "nodejs";

const { app } = createAppFromEnv();
const handler = handle(app);

/**
 * Vercel’s Node runtime ignores a Response returned from a bare default
 * function (`(req, res) => void`), so `export default handle(app)` never
 * writes a body and /health hangs. Named methods and a `fetch` export are
 * the signatures it actually invokes.
 */
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;

export default {
  fetch(request: Request) {
    return handler(request);
  },
};
