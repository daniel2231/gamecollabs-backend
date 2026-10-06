import { describe, expect, it } from "vitest";
import { CollabInput, CollabListQuery, IngestCandidate, PeriodInput, TransitionInput } from "../src/index.js";

describe("shared schemas", () => {
  it("parses list queries from comma lists and repeated params", () => {
    const q = CollabListQuery.parse({ platform: "platform.mobile,platform.pc", region: ["region.korea", "region.japan"], limit: "10" });
    expect(q).toMatchObject({ platform: ["platform.mobile", "platform.pc"], region: ["region.korea", "region.japan"], limit: 10, locale: "ko", sort: "start_desc" });
    expect(CollabListQuery.safeParse({ platform: "region.korea" }).success).toBe(false);
    expect(CollabListQuery.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("validates periods", () => {
    expect(PeriodInput.safeParse({ start: "2026-10-05", end: "2026-10-01" }).success).toBe(false);
    expect(PeriodInput.safeParse({ end: "2026-10-01" }).success).toBe(false);
    expect(PeriodInput.safeParse({ start: "2026-10", endKind: "permanent" }).success).toBe(true);
    expect(PeriodInput.safeParse({ start: "2026-10-01", end: "2026-10-31", endKind: "tba" }).success).toBe(false);
  });

  it("requires a source and a linked or named party", () => {
    expect(CollabInput.safeParse({ sources: [] }).success).toBe(false);
    expect(CollabInput.safeParse({ sources: [{ url: "ftp://x" }] }).success).toBe(false);
    expect(CollabInput.safeParse({ sources: [{ url: "https://x.com" }], parties: [{ role: "host" }] }).success).toBe(false);
    expect(CollabInput.safeParse({ sources: [{ url: "https://x.com" }], parties: [{ role: "host", name: { en: "Game" } }] }).success).toBe(true);
  });

  it("requires a title in some language for ingest candidates", () => {
    const base = { game: { name: "G" }, partner: { name: "P" }, period: { start: "2026-10-01" }, sources: [{ url: "https://x.com" }] };
    expect(IngestCandidate.safeParse({ ...base, title: {} }).success).toBe(false);
    expect(IngestCandidate.safeParse({ ...base, title: { en: "G x P" } }).success).toBe(true);
  });

  it("requires a reason to reject", () => {
    expect(TransitionInput.safeParse({ action: "reject" }).success).toBe(false);
    expect(TransitionInput.safeParse({ action: "reject", reason: "dup" }).success).toBe(true);
  });
});
