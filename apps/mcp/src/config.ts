import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Public origin behind Cloudflare Tunnel, e.g. https://mcp.example.com */
  PUBLIC_URL: z.url(),
  /** Express API on the internal Docker network. */
  API_URL: z.url().default("http://api:3000"),
  /** Ingest-scoped API token. Lives only in this environment, never in tool arguments or prompts. */
  INTERNAL_API_KEY: z.string().min(10),
  /** Signs OAuth access/refresh tokens issued to MCP clients. */
  MCP_JWT_SECRET: z.string().min(32),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  /** The single GitHub account allowed to connect. */
  ALLOWED_GITHUB_LOGIN: z.string().min(1).transform((v) => v.toLowerCase()),
  /** Registered OAuth clients are persisted here (a Docker volume). */
  DATA_DIR: z.string().default("./data"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/**
 * Local development: reads `.env` from the current directory and from the
 * repository root (pnpm runs package scripts inside `apps/*`). Variables
 * already set in the shell or by Docker always win over the file.
 */
export function loadDotEnv(): void {
  const candidates = new Set([resolve(".env"), resolve("../../.env")]);
  for (const file of candidates) if (existsSync(file)) process.loadEnvFile(file);
}
