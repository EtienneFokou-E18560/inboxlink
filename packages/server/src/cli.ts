import { startServer } from "./index.js";

startServer().catch((err) => {
  console.error("[inboxlink] failed to start", err);
  process.exit(1);
});
