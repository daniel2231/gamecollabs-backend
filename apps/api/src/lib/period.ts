import type { Phase } from "@gamecollabs/schema";

export type Precision = "day" | "month" | "unknown";
export type EndKind = "fixed" | "permanent" | "tba";

export type StoredPeriod = {
  start: Date | null;
  end: Date | null;
  precision: Precision;
  endKind: EndKind;
  /** Exclusive end instant, derived from `end` and `precision`. Never set by clients. */
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
    : new Date(end.getTime() + 86_400_000);
}

export function toStoredPeriod(input: {
  start?: string | null;
  end?: string | null;
  precision?: Precision;
  endKind?: EndKind;
}): StoredPeriod {
  const start = input.start ? parseDateInput(input.start) : null;
  const end = input.end ? parseDateInput(input.end) : null;
  const precision: Precision =
    input.precision ?? (!input.start ? "unknown" : input.start.length === 7 ? "month" : "day");
  const endKind = input.endKind ?? "fixed";
  return { start, end, precision, endKind, until: untilOf(end, precision) };
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
