import type { Server } from "node:http";
import { config } from "./config.js";
import { connectDb, disconnectDb } from "./db.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { startScheduler } from "./jobs/index.js";

async function main() {
  const cfg = config();
  await connectDb(cfg.MONGODB_URI);
  const server: Server = createApp().listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, "api listening"));
  const stopScheduler = cfg.SCHEDULER_ENABLED ? startScheduler() : () => undefined;

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    stopScheduler();
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    server.close(async () => {
      await disconnectDb();
      clearTimeout(force);
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
