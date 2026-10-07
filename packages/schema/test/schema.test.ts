import { describe, expect, it } from "vitest";
import { CollabInput, CollabListQuery, CompanyInput, IngestCandidate, PeriodInput, PropertyInput, TransitionInput } from "../src/index.js";

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

  const i18n = { ko: { title: "게임 × IP", summary: "요약" }, en: { title: "Game x IP", summary: "Summary" } };

  it("requires a source and a linked or named party", () => {
    expect(CollabInput.safeParse({ i18n, sources: [] }).success).toBe(false);
    expect(CollabInput.safeParse({ i18n, sources: [{ url: "ftp://x" }] }).success).toBe(false);
    expect(CollabInput.safeParse({ i18n, sources: [{ url: "https://x.com" }], parties: [{ role: "host" }] }).success).toBe(false);
    expect(CollabInput.safeParse({ i18n, sources: [{ url: "https://x.com" }], parties: [{ role: "host", name: { ko: "게임", en: "Game" } }] }).success).toBe(true);
  });

  it("requires Korean and English everywhere", () => {
    const sources = [{ url: "https://x.com" }];
    expect(CollabInput.safeParse({ sources }).success).toBe(false);
    expect(CollabInput.safeParse({ sources, i18n: { ko: i18n.ko } }).success).toBe(false);
    expect(CollabInput.safeParse({ sources, i18n: { ...i18n, en: { title: "Game x IP", summary: "" } } }).success).toBe(false);
    expect(CollabInput.safeParse({ sources, i18n: { ...i18n, ko: { ...i18n.ko, note: "메모" } } }).success).toBe(false);
    expect(CollabInput.safeParse({ sources, i18n, parties: [{ role: "host", name: { en: "Game" } }] }).success).toBe(false);
    expect(CollabInput.safeParse({ sources, i18n, cover: { originalUrl: "https://x.com/a.jpg", alt: { ko: "대표 이미지" } } }).success).toBe(false);
    expect(PropertyInput.safeParse({ slug: "game", kind: "partner_category.game", name: { en: "Game" } }).success).toBe(false);
    expect(PropertyInput.safeParse({ slug: "game", kind: "partner_category.game", name: { ko: "게임", en: "Game" } }).success).toBe(true);
    expect(CompanyInput.safeParse({ slug: "co", name: { ko: "회사" } }).success).toBe(false);
  });

  it("requires both languages for ingest candidates", () => {
    const base = { game: { name: "G" }, partner: { name: "P" }, period: { start: "2026-10-01" }, sources: [{ url: "https://x.com" }] };
    const summary = { ko: "요약", en: "Summary" };
    expect(IngestCandidate.safeParse({ ...base, summary, title: { en: "G x P" } }).success).toBe(false);
    expect(IngestCandidate.safeParse({ ...base, summary: { ko: "요약" }, title: { ko: "G × P", en: "G x P" } }).success).toBe(false);
    expect(IngestCandidate.safeParse({ ...base, summary, title: { ko: "G × P", en: "G x P" } }).success).toBe(true);
  });

  it("requires a reason to reject", () => {
    expect(TransitionInput.safeParse({ action: "reject" }).success).toBe(false);
    expect(TransitionInput.safeParse({ action: "reject", reason: "dup" }).success).toBe(true);
  });
});
