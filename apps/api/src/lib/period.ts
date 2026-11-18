import { CONDITIONAL_DEFAULT_DAYS, type EndCondition, type EndKind, type Phase } from "@gamecollabs/schema";

export type Precision = "day" | "month" | "unknown";
export type { EndKind };

const DAY = 86_400_000;

export type StoredPeriod = {
  start: Date | null;
  end: Date | null;
  precision: Precision;
  endKind: EndKind;
  /** Only for `conditional`. */
  endCondition: EndCondition | null;
  endNote: { ko: string; en: string } | null;
  /** Approximate end a source gives for a `conditional` collab; `expectedPrecision` says day or month. */
  expectedEnd: Date | null;
  expectedPrecision: "day" | "month" | null;
  /**
   * Exclusive end instant used for phases. `fixed`: from `end` and `precision`. `conditional`: from
   * `expectedEnd`, else `start` + `CONDITIONAL_DEFAULT_DAYS` (shown as ended after that; never stored as `end`).
   * Never set by clients.
   */
  until: Date | null;
};

/** Parses `YYYY-MM-DD` or `YYYY-MM` to UTC midnight. */
export function parseDateInput(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d ?? 1));
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== m! - 1 || (d && date.getUTCDate() !== d)) {
    throw new RangeError(`invalid date: ${value}`);
  }
  return date;
}

export function formatDate(date: Date | null | undefined, precision: Precision = "day"): string | null {
  if (!date) return null;
  const iso = date.toISOString();
  return precision === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export function untilOf(end: Date | null, precision: Precision): Date | null {
  if (!end) return null;
  return precision === "month"
    ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1))
    : new Date(end.getTime() + DAY);
}

/** `until` for any end kind (see `StoredPeriod.until`). */
export function untilOfPeriod(p: {
  start?: Date | null;
  end?: Date | null;
  precision?: Precision | null;
  endKind?: EndKind | null;
  expectedEnd?: Date | null;
  expectedPrecision?: "day" | "month" | null;
}): Date | null {
  if (p.endKind === "conditional") {
    if (p.expectedEnd) return untilOf(p.expectedEnd, p.expectedPrecision ?? "day");
    return p.start ? new Date(p.start.getTime() + CONDITIONAL_DEFAULT_DAYS * DAY) : null;
  }
  return untilOf(p.end ?? null, p.precision ?? "unknown");
}

export function toStoredPeriod(input: {
  start?: string | null;
  end?: string | null;
  precision?: Precision;
  endKind?: EndKind;
  endCondition?: EndCondition | null;
  endNote?: { ko: string; en: string } | null;
  expectedEnd?: string | null;
}): StoredPeriod {
  const start = input.start ? parseDateInput(input.start) : null;
  const end = input.end ? parseDateInput(input.end) : null;
  const precision: Precision =
    input.precision ?? (!input.start ? "unknown" : input.start.length === 7 ? "month" : "day");
  const endKind = input.endKind ?? "fixed";
  const conditional = endKind === "conditional";
  const expectedEnd = conditional && input.expectedEnd ? parseDateInput(input.expectedEnd) : null;
  const expectedPrecision = expectedEnd ? (input.expectedEnd!.length === 7 ? "month" : "day") : null;
  const period = {
    start,
    end,
    precision,
    endKind,
    endCondition: conditional ? (input.endCondition ?? null) : null,
    endNote: conditional ? (input.endNote ?? null) : null,
    expectedEnd,
    expectedPrecision,
  } as const;
  return { ...period, until: untilOfPeriod(period) };
}

/** `upcoming`/`ongoing`/`ended` are computed per request, never stored. */
export function phaseOf(period: Pick<StoredPeriod, "start" | "until" | "endKind">, now = new Date()): Phase {
  if (!period.start) return "unknown";
  if (now < period.start) return "upcoming";
  if (period.until) return now < period.until ? "ongoing" : "ended";
  // No end date: permanent and TBA collabs keep running; a fixed one with a missing end is unknown.
  return period.endKind === "fixed" ? "unknown" : "ongoing";
}

/** Mongo filter equivalent of `phaseOf` for list queries. */
export function phaseFilter(phase: Phase, now = new Date()): Record<string, unknown> {
  switch (phase) {
    case "upcoming":
      return { "period.start": { $gt: now } };
    case "ongoing":
      return {
        "period.start": { $lte: now },
        $or: [{ "period.until": { $gt: now } }, { "period.until": null, "period.endKind": { $in: ["permanent", "tba"] } }],
      };
    case "ended":
      return { "period.start": { $lte: now }, "period.until": { $lte: now } };
    case "unknown":
      return {
        $or: [
          { "period.start": null },
          { "period.start": { $lte: now }, "period.until": null, "period.endKind": "fixed" },
        ],
      };
  }
}

/** Order of phases in the `current` sort. */
export const PHASE_RANK: Record<Phase, number> = { ongoing: 0, upcoming: 1, ended: 2, unknown: 3 };

/**
 * Aggregation stage adding `_rank` (phase, same rules as `phaseOf`) and `_key` (ascending number inside
 * the phase) for the `current` sort: ongoing by newest start, upcoming by soonest start, ended by most
 * recent end, unknown by newest start (no start last).
 */
export function currentSortFields(now = new Date()) {
  const start = { $ifNull: ["$period.start", null] };
  const until = { $ifNull: ["$period.until", null] };
  const ms = (field: unknown) => ({ $toLong: field });
  const neg = (field: unknown) => ({ $multiply: [ms(field), -1] });
  const rank = {
    $switch: {
      branches: [
        { case: { $eq: [start, null] }, then: PHASE_RANK.unknown },
        { case: { $lt: [now, start] }, then: PHASE_RANK.upcoming },
        { case: { $ne: [until, null] }, then: { $cond: [{ $lt: [now, until] }, PHASE_RANK.ongoing, PHASE_RANK.ended] } },
        { case: { $in: ["$period.endKind", ["permanent", "tba"]] }, then: PHASE_RANK.ongoing },
      ],
      default: PHASE_RANK.unknown,
    },
  };
  return {
    $addFields: {
      _rank: rank,
      _key: {
        $switch: {
          branches: [
            { case: { $eq: [start, null] }, then: { $toLong: 0 } },
            { case: { $lt: [now, start] }, then: ms(start) },
            { case: { $and: [{ $ne: [until, null] }, { $lte: [until, now] }] }, then: neg(until) },
          ],
          default: neg(start),
        },
      },
    },
  };
}
