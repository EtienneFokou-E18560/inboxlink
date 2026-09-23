import { startServer } from "./index.js";
import { log } from "./log.js";

startServer().catch((err) => {
  log.error("server_start_failed", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
