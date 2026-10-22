import type { FollowUpReason } from "@gamecollabs/schema";
import type { StoredPeriod } from "./period.js";

const DAY = 86_400_000;

/** Days until the next check, by number of checks in a row that found nothing new. */
export const CHECK_INTERVAL_DAYS = [3, 7, 14, 30] as const;

/** After this many checks in a row without news, an admin is asked to decide (once). */
export const ESCALATE_AFTER = 5;

type PeriodLike = Pick<StoredPeriod, "start" | "end" | "until" | "precision" | "endKind">;

/**
 * `null` when the collab needs no further checks (complete, ended or archived). Missing dates come
 * first; the content is checked alongside them (the checker sees `contentTba` in every row).
 */
export function followUpReasonOf(
  c: { status: string; period?: Partial<PeriodLike> | null; contentTba?: boolean | null },
  now = new Date(),
): FollowUpReason | null {
  if (c.status === "archived") return null;
  const p = c.period ?? {};
  if (!p.start) return "start_tba";
  if (p.until && p.until <= now) return null;
  if (p.precision === "month") {
    const monthOver = new Date(Date.UTC(p.start.getUTCFullYear(), p.start.getUTCMonth() + 1, 1));
    if (now < monthOver) return "month_only";
  }
  if (!p.end) {
    if (p.endKind === "tba") return "end_tba";
    if (p.endKind === "fixed") return "end_missing";
  }
  if (c.contentTba) return "content_tba";
  return null;
}

export function nextCheckAt(unchanged: number, from = new Date()): Date {
  const days = CHECK_INTERVAL_DAYS[Math.min(unchanged, CHECK_INTERVAL_DAYS.length - 1)]!;
  return new Date(from.getTime() + days * DAY);
}

/** Fields to store when the reason changes: a new reason restarts the schedule. */
export function followUpReset(reason: FollowUpReason | null, now = new Date(), dueNow = false) {
  return {
    reason,
    unchanged: 0,
    escalatedAt: null,
    nextCheckAt: reason ? (dueNow ? now : nextCheckAt(0, now)) : null,
  };
}
