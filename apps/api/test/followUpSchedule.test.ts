import { describe, expect, it } from "vitest";
import { followUpReasonOf, followUpReset, nextCheckAt, shouldEscalate, type FollowUpSubject } from "../src/lib/followUp.js";
import { toStoredPeriod } from "../src/lib/period.js";

const DAY = 86_400_000;
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const subject = (period: Parameters<typeof toStoredPeriod>[0], contentTba = false, status = "published"): FollowUpSubject => ({
  status,
  period: toStoredPeriod(period),
  contentTba,
});

describe("follow-up reasons", () => {
  const now = at("2026-10-13");
  const reason = (period: Parameters<typeof toStoredPeriod>[0], status = "published", contentTba = false) =>
    followUpReasonOf({ status, period: toStoredPeriod(period), contentTba }, now);

  it("derives what is still missing from the period", () => {
    expect(reason({ endKind: "tba" }, "draft")).toBe("start_tba");
    expect(reason({ endKind: "tba", expectedStart: "2027-01" }, "draft")).toBe("start_tba");
    expect(reason({ start: "2026-11", endKind: "tba" })).toBe("month_only");
    expect(reason({ start: "2026-10", endKind: "tba" })).toBe("month_only");
    // Once the start month is over, the end is what matters.
    expect(reason({ start: "2026-09", endKind: "tba" })).toBe("end_tba");
    expect(reason({ start: "2026-10-01", endKind: "tba" })).toBe("end_tba");
    expect(reason({ start: "2026-10-01" })).toBe("end_missing");
  });

  it("stops for complete, permanent, ended and archived collabs", () => {
    expect(reason({ start: "2026-10-01", end: "2026-10-31" })).toBeNull();
    expect(reason({ start: "2026-10-01", endKind: "permanent" })).toBeNull();
    expect(reason({ start: "2026-08-01", end: "2026-09-30" })).toBeNull();
    expect(reason({ endKind: "tba" }, "archived")).toBeNull();
  });

  it("re-checks the content once the dates are known", () => {
    expect(reason({ start: "2026-10-01", end: "2026-10-31" }, "published", true)).toBe("content_tba");
    expect(reason({ start: "2026-10-01", endKind: "permanent" }, "published", true)).toBe("content_tba");
    // Missing dates come first; ended and archived collabs are not re-checked.
    expect(reason({ endKind: "tba" }, "draft", true)).toBe("start_tba");
    expect(reason({ start: "2026-10-01", endKind: "tba" }, "published", true)).toBe("end_tba");
    expect(reason({ start: "2026-08-01", end: "2026-09-30" }, "published", true)).toBeNull();
    expect(reason({ start: "2026-10-01", end: "2026-10-31" }, "archived", true)).toBeNull();
  });

  it("keeps expectedStart only while the start is not out", () => {
    expect(toStoredPeriod({ endKind: "tba", expectedStart: "2027-09" })).toMatchObject({ expectedStart: at("2027-09-01"), expectedStartPrecision: "month" });
    expect(toStoredPeriod({ start: "2027-09-10", endKind: "tba", expectedStart: "2027-09" })).toMatchObject({ expectedStart: null, expectedStartPrecision: null });
  });
});

describe("follow-up schedule", () => {
  const now = at("2026-11-27");
  const steps = (c: FollowUpSubject, unchanged: number, from: Date, n: number) => {
    const out: (string | null)[] = [];
    let t: Date | null = from;
    for (let i = 0; i < n && t; i++) {
      t = nextCheckAt(c, unchanged + i, t);
      out.push(day(t));
    }
    return out;
  };

  it("backs off 3 → 7 → 14 → 30 days without any date to go by", () => {
    const c = subject({ endKind: "tba" }, false, "draft");
    expect([0, 1, 2, 3, 9].map((n) => (nextCheckAt(c, n, now)!.getTime() - now.getTime()) / DAY)).toEqual([3, 7, 14, 30, 30]);
  });

  it("checks content 14 and 7 days before the start, then every 3 days", () => {
    // Granblue Fantasy x Sanrio: 12/26–27, content not announced, already three checks without news.
    const c = subject({ start: "2026-12-26", end: "2026-12-27" }, true);
    expect(steps(c, 3, now, 5)).toEqual(["2026-12-12", "2026-12-19", "2026-12-22", "2026-12-25", "2026-12-26"]);
    // Running: weekly. The daily job drops it once the event is over, before that check comes.
    expect(day(nextCheckAt(c, 8, at("2026-12-26")))).toBe("2027-01-02");
    expect(followUpReasonOf(c, at("2026-12-28"))).toBeNull();
  });

  it("caps running collabs without an end at 7 days", () => {
    // Emberstoria x FF XIII: running since 11/1, end not announced.
    const c = subject({ start: "2026-11-01", endKind: "tba" });
    expect([1, 3, 6].map((n) => day(nextCheckAt(c, n, now)))).toEqual(["2026-12-04", "2026-12-04", "2026-12-04"]);
    expect(day(nextCheckAt(c, 0, now))).toBe("2026-11-30");
  });

  it("closes in on a known start month and checks every 3 days inside it", () => {
    // Sonic Racing x Evangelion: January 2027.
    const c = subject({ start: "2027-01", endKind: "tba" });
    expect(steps(c, 1, now, 6)).toEqual(["2026-12-02", "2026-12-16", "2026-12-18", "2026-12-25", "2026-12-28", "2026-12-31"]);
    expect(day(nextCheckAt(c, 7, at("2027-01-10")))).toBe("2027-01-13");
  });

  it("waits far from an expected window, then checks weekly once it opens", () => {
    // Sonic Racing x FF VII Remake: "September to December 2027".
    const c = subject({ endKind: "tba", expectedStart: "2027-09" }, true, "draft");
    expect(day(nextCheckAt(c, 0, now))).toBe("2026-11-30"); // the first check stays early
    expect(day(nextCheckAt(c, 2, now))).toBe("2027-01-26");
    expect(day(nextCheckAt(c, 4, at("2027-07-01")))).toBe("2027-08-02");
    expect(day(nextCheckAt(c, 5, at("2027-09-05")))).toBe("2027-09-12");
    // The window and its 30-day grace period are over: plain back-off again.
    expect(day(nextCheckAt(c, 5, at("2027-11-01")))).toBe("2027-12-01");
  });

  it("never schedules sooner than a day", () => {
    const c = subject({ start: "2026-12-26", end: "2026-12-27" }, true);
    const from = new Date("2026-12-18T23:00:00Z"); // an hour before the 7-day mark
    expect(nextCheckAt(c, 3, from)!.toISOString()).toBe("2026-12-19T23:00:00.000Z");
  });

  it("stops when nothing is missing", () => {
    expect(nextCheckAt(subject({ start: "2026-12-01", end: "2026-12-31" }), 2, now)).toBeNull();
    expect(followUpReset(subject({ start: "2026-12-01", end: "2026-12-31" }), now)).toMatchObject({ reason: null, since: null, nextCheckAt: null });
    expect(followUpReset(subject({ endKind: "tba" }, false, "draft"), now, true)).toMatchObject({ reason: "start_tba", since: now, nextCheckAt: now, unchanged: 0 });
  });
});

describe("follow-up escalation", () => {
  const since = at("2026-08-01");
  const esc = (c: FollowUpSubject, unchanged: number, now: string, from = since) => shouldEscalate(c, { unchanged, since: from }, at(now));

  it("escalates start_tba by the expected window, else 120 days after queuing", () => {
    const plain = subject({ endKind: "tba" }, false, "draft");
    expect(esc(plain, 3, "2026-11-28")).toBe(false);
    expect(esc(plain, 3, "2026-11-29")).toBe(true);
    expect(esc(plain, 1, "2026-12-31")).toBe(false); // at least two checks without news
    const windowed = subject({ endKind: "tba", expectedStart: "2027-01" }, false, "draft");
    expect(esc(windowed, 4, "2027-03-02")).toBe(false);
    expect(esc(windowed, 4, "2027-03-03")).toBe(true);
  });

  it("escalates missing ends 60 days after the start and missing content a week after it", () => {
    const running = subject({ start: "2026-11-01", endKind: "tba" });
    expect(esc(running, 4, "2026-12-30")).toBe(false);
    expect(esc(running, 4, "2026-12-31")).toBe(true);
    const content = subject({ start: "2026-12-26", end: "2026-12-27" }, true);
    expect(esc(content, 6, "2026-12-26")).toBe(false);
    // 7 days after the start a 2-day event has ended, so there is nothing left to escalate.
    expect(esc(subject({ start: "2026-12-01", endKind: "permanent" }, true), 2, "2026-12-08")).toBe(true);
  });

  it("does not escalate a known start month, except after many checks", () => {
    const month = subject({ start: "2027-01", endKind: "tba" });
    expect(esc(month, 7, "2027-01-20")).toBe(false);
    expect(esc(month, 8, "2027-01-20")).toBe(true);
  });
});
