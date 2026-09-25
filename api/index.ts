import { createVercelHandler } from "@inboxlink/server";

export const runtime = "nodejs";
/** Inline sync may run Gmail list + history + concurrent getMessage; keep headroom. */
export const maxDuration = 60;

export default createVercelHandler();
