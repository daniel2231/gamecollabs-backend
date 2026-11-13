import { pino, type LoggerOptions } from "pino";

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "api" },
  // x-client-ip is the visitor's address that Next.js relays for submissions: it must not reach the logs
  // (the web's privacy policy says submissions keep only a hash, cleared after IP_HASH_RETENTION_DAYS).
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-client-ip"]'], remove: true },
};

export const logger = pino(loggerOptions);
