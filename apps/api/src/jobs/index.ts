import cron from "node-cron";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { withJobLock } from "./lock.js";
import { consistency, exportJson, linkCheck, mirrorCovers, recount, reindexFacets } from "./tasks.js";
import { discoverWithOpenAI } from "./discover.js";

type Job = { run: () => Promise<unknown>; schedule: string; ttlMs: number; enabled?: () => boolean };

const MIN = 60_000;

/** Every job is idempotent and can also be run from the CLI (`pnpm --filter @gamecollabs/api job <name>`). Times are KST. */
export const JOBS: Record<string, Job> = {
  "link-check": { run: linkCheck, schedule: "10 4 * * 1", ttlMs: 60 * MIN },
  recount: { run: recount, schedule: "20 3 * * *", ttlMs: 10 * MIN },
  "reindex-facets": { run: reindexFacets, schedule: "40 3 * * *", ttlMs: 10 * MIN },
  consistency: { run: consistency, schedule: "40 4 * * 0", ttlMs: 20 * MIN },
  "mirror-covers": { run: () => mirrorCovers(), schedule: "15 * * * *", ttlMs: 20 * MIN },
  "export-json": { run: () => exportJson(), schedule: "0 5 * * 0", ttlMs: 10 * MIN },
  "discover-openai": {
    run: () => discoverWithOpenAI(),
    schedule: "5 9 * * *",
    ttlMs: 30 * MIN,
    enabled: () => !!config().OPENAI_API_KEY,
  },
};

export function runJob(name: string) {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job ${name}; known: ${Object.keys(JOBS).join(", ")}`);
  return withJobLock(name, job.ttlMs, job.run);
}

export function startScheduler(): () => void {
  const tasks = Object.entries(JOBS)
    .filter(([, job]) => job.enabled?.() ?? true)
    .map(([name, job]) =>
      cron.schedule(job.schedule, () => runJob(name).catch(() => undefined), { timezone: "Asia/Seoul", name, noOverlap: true }),
    );
  logger.info({ jobs: tasks.length }, "scheduler started");
  return () => tasks.forEach((t) => t.stop());
}
