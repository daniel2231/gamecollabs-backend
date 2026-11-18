import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "../src/logger.js";
import { indexTokens, nameKey, queryTokens, slugify } from "../src/lib/text.js";
import { phaseOf, toStoredPeriod } from "../src/lib/period.js";
import { followUpReasonOf } from "../src/lib/followUp.js";
import { normalizeUrl } from "../src/lib/url.js";
import { isPrivateAddress } from "../src/lib/safeFetch.js";
import { TaxonomyIndex, type Term } from "../src/services/taxonomy.js";
import { startOfKstDay } from "../src/services/ingest.js";
import { matchOf } from "../src/cli/contentTba.js";
import { publishedAtFor } from "../src/cli/migrate.js";

describe("search tokens", () => {
  it("indexes Hangul as 2-grams and Latin words with prefixes", () => {
    const tokens = indexTokens("진격의 거인 × Attack on Titan");
    expect(tokens).toEqual(expect.arrayContaining(["진격", "격의", "거인", "attack", "at", "att", "titan", "ti"]));
  });

  it("a query matches when all of its tokens are indexed", () => {
    const indexed = new Set(indexTokens("배틀그라운드 모바일", "PUBG Mobile"));
    for (const q of ["배틀그라운드", "모바일", "pubg mob", "PUBG"]) {
      expect(queryTokens(q).every((t) => indexed.has(t)), q).toBe(true);
    }
    expect(queryTokens("배틀필드").every((t) => indexed.has(t))).toBe(false);
  });

  it("normalizes names for comparison and slugs", () => {
    expect(nameKey("Pokémon GO!")).toBe(nameKey("pokemon go"));
    expect(slugify("Taiko no Tatsujin × Jagariko")).toBe("taiko-no-tatsujin-jagariko");
    expect(slugify("진격의 거인")).toBe("");
  });
});

describe("period and phase", () => {
  const now = new Date("2026-10-06T03:00:00Z");

  it("derives precision and an exclusive end", () => {
    const p = toStoredPeriod({ start: "2026-10", end: "2026-11" });
    expect(p.precision).toBe("month");
    expect(p.until?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(toStoredPeriod({ start: "2026-10-05", end: "2026-10-06" }).until?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("computes phases", () => {
    expect(phaseOf(toStoredPeriod({ start: "2026-10-07" }), now)).toBe("upcoming");
    expect(phaseOf(toStoredPeriod({ start: "2026-10-01", end: "2026-10-06" }), now)).toBe("ongoing");
    expect(phaseOf(toStoredPeriod({ start: "2026-09-01", end: "2026-10-05" }), now)).toBe("ended");
    expect(phaseOf(toStoredPeriod({ start: "2026-01-01", endKind: "permanent" }), now)).toBe("ongoing");
    expect(phaseOf(toStoredPeriod({ start: "2026-01-01" }), now)).toBe("unknown");
    expect(phaseOf(toStoredPeriod({}), now)).toBe("unknown");
  });

  it("rejects impossible dates", () => {
    expect(() => toStoredPeriod({ start: "2026-02-30" })).toThrow();
  });
});

describe("conditional ends", () => {
  const now = new Date("2026-11-18T00:00:00Z");

  it("uses the expected end when a source gives one", () => {
    const p = toStoredPeriod({ start: "2026-11-06", endKind: "conditional", endCondition: "tied_event", expectedEnd: "2026-12" });
    expect(p.end).toBeNull();
    expect(p.until?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(phaseOf(p, now)).toBe("ongoing");
    expect(phaseOf(p, new Date("2027-01-02T00:00:00Z"))).toBe("ended");
  });

  it("falls back to 60 days after the start for display, without storing an end", () => {
    const p = toStoredPeriod({ start: "2026-11-04", endKind: "conditional", endCondition: "sold_out" });
    expect(p.end).toBeNull();
    expect(p.until?.toISOString()).toBe("2027-01-03T00:00:00.000Z");
    expect(phaseOf(p, now)).toBe("ongoing");
    expect(phaseOf(p, new Date("2027-01-03T00:00:00Z"))).toBe("ended");
    expect(phaseOf(toStoredPeriod({ endKind: "conditional", endCondition: "sold_out" }), now)).toBe("unknown");
  });

  it("drops condition fields from other end kinds", () => {
    const p = toStoredPeriod({ start: "2026-11-04", endKind: "tba", endCondition: "sold_out", expectedEnd: "2026-12" });
    expect(p).toMatchObject({ endCondition: null, expectedEnd: null, until: null });
  });

  it("re-checks only conditions tied to another event", () => {
    const status = "published";
    const tied = toStoredPeriod({ start: "2026-11-06", endKind: "conditional", endCondition: "tied_event" });
    const soldOut = toStoredPeriod({ start: "2026-11-04", endKind: "conditional", endCondition: "sold_out" });
    expect(followUpReasonOf({ status, period: tied }, now)).toBe("end_tied");
    expect(followUpReasonOf({ status, period: soldOut }, now)).toBeNull();
    expect(followUpReasonOf({ status, period: soldOut, contentTba: true }, now)).toBe("content_tba");
    // once the estimated end has passed, nothing is re-checked
    expect(followUpReasonOf({ status, period: tied }, new Date("2027-02-01T00:00:00Z"))).toBeNull();
  });
});

describe("migrated publication date", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  it("uses the start date when it has passed and now otherwise", () => {
    expect(publishedAtFor(new Date("2026-09-01T00:00:00Z"), now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(publishedAtFor(new Date("2027-01-15T00:00:00Z"), now)).toBe(now);
    expect(publishedAtFor(null, now)).toBe(now);
  });
});

describe("urls", () => {
  it("normalizes source urls", () => {
    expect(normalizeUrl("https://Example.com/a/?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/a?a=1&b=2");
  });

  it("detects private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
  });
});

describe("taxonomy index", () => {
  const term = (key: string, parent: string | null, ancestors: string[], en: string, legacyValues: string[] = []): Term => ({
    _id: key,
    taxonomy: key.split(".")[0] as Term["taxonomy"],
    parent,
    ancestors,
    label: { ko: en, en },
    order: 0,
    deprecated: false,
    legacyValues,
  });
  const index = new TaxonomyIndex([
    term("platform.mobile", null, [], "Mobile"),
    term("platform.android", "platform.mobile", ["platform.mobile"], "Android"),
    term("region.korea", null, [], "Korea", ["South Korea"]),
  ]);

  it("maps legacy values and labels to keys", () => {
    expect(index.map("region", "South Korea")).toBe("region.korea");
    expect(index.map("region", "korea")).toBe("region.korea");
    expect(index.map("platform", "android")).toBe("platform.android");
    expect(index.map("platform", "platform.android")).toBe("platform.android");
    expect(index.map("platform", "Commodore 64")).toBeNull();
  });

  it("expands ancestors for facet keys", () => {
    expect(index.expand(["platform.android", "region.korea"])).toEqual(["platform.android", "platform.mobile", "region.korea"]);
  });

  it("validates keys against their taxonomy", () => {
    expect(index.problemWith("platform.android", "platform")).toBeNull();
    expect(index.problemWith("platform.android", "region")).toMatch(/expected a region key/);
    expect(index.problemWith("platform.n64", "platform")).toMatch(/unknown/);
  });
});

describe("ingest day boundary", () => {
  it("uses the KST calendar day", () => {
    expect(startOfKstDay(new Date("2026-10-06T14:59:00Z")).toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(startOfKstDay(new Date("2026-10-06T15:00:00Z")).toISOString()).toBe("2026-10-06T15:00:00.000Z");
  });
});

describe("content TBA scan", () => {
  const m = (summary: string) => matchOf([{ summary }]);
  it("matches wording about content still to come", () => {
    expect(m("콜라보가 예고됐으며 자세한 내용은 추후 공개될 예정이다.")).not.toBeNull();
    expect(m("콜라보 보상 구성은 미정이다.")).not.toBeNull();
    expect(m("A collab was teased; details will be revealed later.")).not.toBeNull();
    expect(m("More information is coming soon. Stay tuned!")).not.toBeNull();
  });
  it("ignores dates still to come", () => {
    expect(m("게이밍 기어 4종으로 구성되며 출시 일정은 추후 공개될 예정이다.")).toBeNull();
    expect(m("Four gaming gear items, with the release schedule to be announced later.")).toBeNull();
    expect(m("진격의 거인 테마 스킨과 맵이 추가된다.")).toBeNull();
  });
});

describe("logger", () => {
  it("drops the visitor IP and credentials from request logs", () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const log = pino({ ...loggerOptions, level: "info" }, sink);
    log.info({ req: { method: "POST", url: "/v1/submissions", headers: { "x-client-ip": "203.0.113.7", authorization: "Bearer t", cookie: "a=b", "user-agent": "ua" } } });
    const entry = JSON.parse(lines[0]!);
    expect(entry.req.headers).toEqual({ "user-agent": "ua" });
    expect(lines[0]).not.toContain("203.0.113.7");
  });
});
