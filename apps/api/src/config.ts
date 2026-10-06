import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");
const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.url().optional());
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

/**
 * Every host and secret comes from the environment so the same image runs on
 * the home server and in the cloud. Validated once at startup.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MONGODB_URI: z.string().min(1),
  /** Comma-separated so a token can be rotated without downtime. */
  SERVICE_TOKENS: list,
  ADMIN_JWT_SECRET: z.string().min(32),
  ADMIN_JWT_ISSUER: z.string().default("gamecollabs-web"),
  ADMIN_JWT_AUDIENCE: z.string().default("gamecollabs-api"),
  CORS_ORIGINS: list,
  /** Blocks every write (runbook: cloud migration). */
  READ_ONLY_MODE: bool,
  WEB_REVALIDATE_URL: optionalUrl,
  WEB_REVALIDATE_SECRET: optionalString,
  ALERT_WEBHOOK_URL: optionalUrl,
  MEDIA_BASE_URL: optionalUrl,
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  TURNSTILE_SECRET: optionalString,
  INGEST_DAILY_LIMIT: z.coerce.number().int().positive().default(100),
  /** Ingest checks that each source URL answers. Off in tests. */
  INGEST_VERIFY_SOURCES: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  /** Allows fetching private addresses (tests, local dev only). */
  ALLOW_PRIVATE_FETCH: bool,
  SCHEDULER_ENABLED: bool,
  EXPORT_DIR: z.string().default("./exports"),
  /** Fallback collector (홈서버 스케줄러 + OpenAI Responses API). Off unless a key is set. */
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  OPENAI_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(10),
  OPENAI_PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(0),
  DISCOVER_PROMPT_PATH: z.string().default("prompts/daily-discover.md"),
  TRUST_PROXY: z.string().default("loopback"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${details}`);
  }
  return parsed.data;
}

let current: Config | undefined;

export function config(): Config {
  current ??= loadConfig();
  return current;
}

/** Tests override the cached config. */
export function setConfig(next: Config): void {
  current = next;
}
