import { hostname } from "node:os";
import { JobLock } from "../models/support.js";
import { logger } from "../logger.js";
import { notify } from "../lib/outbound.js";

const owner = `${hostname()}:${process.pid}`;

/**
 * Runs `fn` only if no other instance holds the job's lock. Jobs are
 * idempotent, so an expired lock (crashed run) can safely be taken over.
 */
export async function withJobLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | "locked"> {
  const now = new Date();
  try {
    await JobLock.findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { owner, lockedUntil: new Date(now.getTime() + ttlMs), lastStartedAt: now } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      logger.info({ job: name }, "job already running elsewhere");
      return "locked";
    }
    throw err;
  }
  const log = logger.child({ job: name });
  log.info("job started");
  try {
    const result = await fn();
    await JobLock.updateOne({ _id: name }, { $set: { lockedUntil: null, lastFinishedAt: new Date(), lastResult: result ?? null, lastError: null } });
    log.info({ result }, "job finished");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await JobLock.updateOne({ _id: name }, { $set: { lockedUntil: null, lastFinishedAt: new Date(), lastError: message } });
    log.error({ err }, "job failed");
    notify(`Job ${name} failed: ${message}`);
    throw err;
  }
}
