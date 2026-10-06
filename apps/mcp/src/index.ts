import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";

const cfg = loadConfig();
const server = createApp(cfg).listen(cfg.PORT, () => logger.info({ port: cfg.PORT, publicUrl: cfg.PUBLIC_URL }, "mcp server listening"));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
