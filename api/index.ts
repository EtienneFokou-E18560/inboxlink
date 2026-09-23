import { handle } from "hono/vercel";
import { createAppFromEnv } from "@inboxlink/server";

export const runtime = "nodejs";

const { app } = createAppFromEnv();

export default handle(app);
