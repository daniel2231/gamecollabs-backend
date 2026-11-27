import type { FollowUpReason } from "@gamecollabs/schema";
import type { StoredPeriod } from "./period.js";

const DAY = 86_400_000;

/** Days until the next check, by number of checks in a row that found nothing new. */
export const CHECK_INTERVAL_DAYS = [3, 7, 14, 30] as const;

/**
 * Date-aware limits on top of the back-off. The anchor is the date the missing information is most likely
 * announced around: the start of an upcoming collab, the known start month, or the `expectedStart` window.
 */
export const SCHEDULE = {
  /** Days before the anchor at which a check is always made, whatever the back-off says. */
  leadDays: [30, 14, 7, 0],
  /** Within this many days before the anchor (and during a known start month), check at least this often. */
  nearDays: 7,
  nearMaxDays: 3,
  /** Started collabs still missing their end or content, and `start_tba` once its expected window opened. */
  runningMaxDays: 7,
  /** More than `leadDays[0]` days before the anchor, after the first check: wait this long (still stopped by the lead days). */
  farDays: 60,
} as const;

/** When an admin is asked to decide (once), after at least `minChecks` checks in a row found nothing. */
export const ESCALATE = {
  minChecks: 2,
  /** Any reason, whatever the dates: a backstop. */
  maxChecks: 8,
  /** `start_tba` without `expectedStart`: days since it was queued. */
  startTbaDays: 120,
  /** `start_tba` with `expectedStart`: days after the expected window (its day or month) is over. */
  expectedGraceDays: 30,
  /** `end_tba` / `end_missing` / `end_tied`: days since the collab started. */
  runningDays: 60,
  /** `content_tba`: days since the collab started. */
  contentStartedDays: 7,
} as const;

type PeriodLike = Pick<StoredPeriod, "start" | "end" | "until" | "precision" | "endKind" | "endCondition" | "expectedStart" | "expectedStartPrecision">;
export type FollowUpSubject = { status: string; period?: Partial<PeriodLike> | null; contentTba?: boolean | null };

/**
 * `null` when the collab needs no further checks (complete, ended or archived). Missing dates come
 * first; the content is checked alongside them (the checker sees `contentTba` in every row).
 */
export function followUpReasonOf(c: FollowUpSubject, now = new Date()): FollowUpReason | null {
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
    // Stock-limited and other conditional ends are never announced as dates: only an event date can come out.
    if (p.endKind === "conditional" && p.endCondition === "tied_event") return "end_tied";
    if (p.endKind === "fixed") return "end_missing";
  }
  if (c.contentTba) return "content_tba";
  return null;
}

/** The date the missing information is most likely announced around, if one is known. */
export function anchorOf(c: FollowUpSubject, reason: FollowUpReason, now = new Date()): Date | null {
  const p = c.period ?? {};
  if (reason === "start_tba") return p.expectedStart ?? null;
  if (reason === "month_only") return p.start ?? null;
  return p.start && p.start > now ? p.start : null;
}

/** End of the `expectedStart` window: the next day, or the first of the next month. */
function expectedWindowEnd(p: Partial<PeriodLike>): Date | null {
  const s = p.expectedStart;
  if (!s) return null;
  return p.expectedStartPrecision === "month" ? new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)) : new Date(s.getTime() + DAY);
}

/**
 * Next check after `unchanged` checks in a row found nothing, made at `from`. The back-off (3 → 7 → 14 → 30 days)
 * is cut short by the lead days before the anchor and capped while an announcement is likely: 3 days in the
 * week before the anchor and during a known start month, 7 days once the collab (or its expected window) started.
 * Far from the anchor it stretches to {@link SCHEDULE.farDays}. Never sooner than a day. `null`: no reason left.
 */
export function nextCheckAt(c: FollowUpSubject, unchanged: number, from = new Date()): Date | null {
  const reason = followUpReasonOf(c, from);
  if (!reason) return null;
  const p = c.period ?? {};
  const t = from.getTime();
  let days: number = CHECK_INTERVAL_DAYS[Math.min(unchanged, CHECK_INTERVAL_DAYS.length - 1)]!;
  let max = Infinity;
  let checkpoint = Infinity;

  const anchor = anchorOf(c, reason, from);
  if (anchor) {
    const lead = (anchor.getTime() - t) / DAY;
    if (lead > SCHEDULE.leadDays[0] && unchanged > 0) days = Math.max(days, SCHEDULE.farDays);
    if (lead >= 0 && lead <= SCHEDULE.nearDays) max = SCHEDULE.nearMaxDays;
    for (const d of SCHEDULE.leadDays) {
      const at = anchor.getTime() - d * DAY;
      if (at > t) checkpoint = Math.min(checkpoint, at);
    }
  }
  if (reason === "month_only" && p.start && p.start <= from) max = Math.min(max, SCHEDULE.nearMaxDays);
  if (reason === "start_tba" && p.expectedStart && p.expectedStart <= from) {
    const over = expectedWindowEnd(p)!.getTime() + ESCALATE.expectedGraceDays * DAY;
    // Once the window and its grace period are over, the plain back-off applies (an admin is asked to decide).
    if (t < over) max = Math.min(max, SCHEDULE.runningMaxDays);
  }
  if (reason !== "start_tba" && reason !== "month_only" && p.start && p.start <= from) max = Math.min(max, SCHEDULE.runningMaxDays);

  const next = Math.min(t + Math.min(days, max) * DAY, checkpoint);
  return new Date(Math.max(next, t + DAY));
}

/**
 * Whether a collab that just had another check without news should go to an admin. Time-based, because how
 * often it is checked depends on its dates: a start window that passed, a collab running for a while without
 * an end, content still missing after the start; {@link ESCALATE.maxChecks} checks in a row in any case.
 */
export function shouldEscalate(c: FollowUpSubject, f: { unchanged: number; since: Date }, now = new Date()): boolean {
  const reason = followUpReasonOf(c, now);
  if (!reason || f.unchanged < ESCALATE.minChecks) return false;
  if (f.unchanged >= ESCALATE.maxChecks) return true;
  const p = c.period ?? {};
  const daysSince = (d: Date) => (now.getTime() - d.getTime()) / DAY;
  switch (reason) {
    case "start_tba": {
      const windowEnd = expectedWindowEnd(p);
      return windowEnd ? daysSince(windowEnd) >= ESCALATE.expectedGraceDays : daysSince(f.since) >= ESCALATE.startTbaDays;
    }
    case "month_only":
      return false; // resolves itself: once the month is over, the end is what is missing
    case "content_tba":
      return !!p.start && daysSince(p.start) >= ESCALATE.contentStartedDays;
    default:
      return !!p.start && daysSince(p.start) >= ESCALATE.runningDays;
  }
}

/** Fields to store when the reason changes: a new reason restarts the schedule. */
export function followUpReset(c: FollowUpSubject, now = new Date(), dueNow = false) {
  const reason = followUpReasonOf(c, now);
  return {
    reason,
    since: reason ? now : null,
    unchanged: 0,
    escalatedAt: null,
    nextCheckAt: reason ? (dueNow ? now : nextCheckAt(c, 0, now)) : null,
  };
}
