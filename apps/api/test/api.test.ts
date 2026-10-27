import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Collab } from "../src/models/collab.js";
import { Property } from "../src/models/entities.js";
import { Revision } from "../src/models/support.js";
import { SERVICE_TOKEN, adminJwt, apiToken, app, as, draftBody, seedEntities, setupDb, teardownDb } from "./helpers.js";

let admin: string;
let editor: string;
let agent: string;
let e: Awaited<ReturnType<typeof seedEntities>>;
const service = () => as(SERVICE_TOKEN);

beforeAll(async () => {
  await setupDb();
  admin = await adminJwt("daniel", "admin");
  editor = await adminJwt("helper", "editor");
  agent = await apiToken("claude-agent", "agent");
  e = await seedEntities();
});
afterAll(teardownDb);

async function createAndPublish(body = draftBody(e.pubg.id, e.aot.id)) {
  const created = await as(admin).post("/v1/admin/collabs").send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const published = await as(admin).post(`/v1/admin/collabs/${created.body.data.id}/transition`).send({ action: "publish" });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body.data;
}

describe("auth", () => {
  it("requires a token everywhere except health checks", async () => {
    expect((await request(app()).get("/healthz")).status).toBe(200);
    const res = await request(app()).get("/v1/collabs");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect((await as("nope").get("/v1/collabs")).status).toBe(401);
  });

  it("limits the service token to public reads", async () => {
    expect((await service().get("/v1/collabs")).status).toBe(200);
    expect((await service().get("/v1/admin/collabs")).status).toBe(403);
    expect((await service().post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id))).status).toBe(403);
  });

  it("rejects JWTs of unknown accounts", async () => {
    const token = await adminJwt("someone", "editor");
    await (await import("../src/models/support.js")).User.updateOne({ githubLogin: "someone" }, { active: false });
    expect((await as(token).get("/v1/admin/collabs")).status).toBe(401);
  });
});

describe("collab workflow", () => {
  it("creates drafts only, with normalized sources and computed facets", async () => {
    const res = await as(agent).post("/v1/admin/collabs").send({ ...draftBody(e.pubg.id, e.aot.id), status: "published" });
    expect(res.status).toBe(201);
    const c = res.body.data;
    expect(c.status).toBe("draft");
    expect(c.slug).toBe("pubg-mobile-x-attack-on-titan-2026-09");
    expect(c.sources[0].url).toBe("https://example.com/news/aot");
    expect(c.sources[0].isPrimary).toBe(true);
    expect(c.facetKeys).toEqual(
      expect.arrayContaining(["region.korea", "region.asia", "platform.android", "platform.mobile", "partner_category.anime_manga"]),
    );
    expect(c.parties[1]).toMatchObject({ slug: "attack-on-titan", kind: "partner_category.anime_manga", name: { ko: "진격의 거인", en: "Attack on Titan" } });
    expect(c.origin.type).toBe("agent");
    expect(c.searchTokens).toBeUndefined();
    expect(await Revision.countDocuments({ collabId: c.id })).toBe(1);
  });

  it("rejects unknown taxonomy keys with the error envelope", async () => {
    const res = await as(admin).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id, { platforms: ["platform.n64"] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.fields.platforms[0]).toMatch(/unknown taxonomy key/);
  });

  it("reports duplicate candidates on create", async () => {
    const res = await as(agent).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id));
    expect(res.status).toBe(201);
    expect(res.body.meta.duplicates[0].reason).toBe("same_source_url");
  });

  it("enforces If-Match on PATCH", async () => {
    const { body } = await as(editor).post("/v1/admin/collabs").send(draftBody(e.blood.id, e.aot.id, { sources: [{ url: "https://example.com/blood" }] }));
    const id = body.data.id;
    expect((await as(editor).patch(`/v1/admin/collabs/${id}`).send({ category: "category.brand_campaign" })).status).toBe(428);
    expect((await as(editor).patch(`/v1/admin/collabs/${id}`).set("if-match", '"9"').send({ category: "category.brand_campaign" })).status).toBe(412);
    const ok = await as(editor).patch(`/v1/admin/collabs/${id}`).set("if-match", '"1"').send({ category: "category.brand_campaign" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rev).toBe(2);
    expect(ok.headers.etag).toBe('"2"');
    const revs = await as(editor).get(`/v1/admin/collabs/${id}/revisions`);
    expect(revs.body.data[0].diff.category).toEqual({ from: "category.in_game", to: "category.brand_campaign" });
  });

  it("runs draft → in_review → published with role checks", async () => {
    const { body } = await as(agent).post("/v1/admin/collabs").send(draftBody(e.blood.id, e.aot.id, { sources: [{ url: "https://example.com/flow" }] }));
    const id = body.data.id;
    expect((await as(agent).post(`/v1/admin/collabs/${id}/transition`).send({ action: "submit" })).status).toBe(403);
    expect((await as(editor).post(`/v1/admin/collabs/${id}/transition`).send({ action: "submit" })).body.data.status).toBe("in_review");
    expect((await as(editor).post(`/v1/admin/collabs/${id}/transition`).send({ action: "publish" })).status).toBe(403);
    const pub = await as(admin).post(`/v1/admin/collabs/${id}/transition`).send({ action: "publish" });
    expect(pub.body.data.status).toBe("published");
    expect(pub.body.data.review.publishedAt).toBeTruthy();
    expect((await Property.findById(e.blood.id))!.collabCount).toBe(1);
    // Agents can no longer edit it.
    const patch = await as(agent).patch(`/v1/admin/collabs/${id}`).set("if-match", String(pub.body.data.rev)).send({ regions: ["region.global"] });
    expect(patch.status).toBe(403);
  });

  it("requires Korean and English text on every collab, even drafts", async () => {
    const base = draftBody(e.pubg.id, e.aot.id, { sources: [{ url: "https://example.com/bilingual" }] });
    const noEn = await as(admin).post("/v1/admin/collabs").send({ ...base, i18n: { ko: base.i18n.ko } });
    expect(noEn.status).toBe(422);
    expect(Object.keys(noEn.body.error.fields)).toEqual(expect.arrayContaining(["i18n.en"]));
    const blankEnSummary = await as(admin).post("/v1/admin/collabs").send({ ...base, i18n: { ko: base.i18n.ko, en: { title: "X", summary: "  " } } });
    expect(blankEnSummary.body.error.fields["i18n.en.summary"]).toBeTruthy();
    const oneNote = await as(admin).post("/v1/admin/collabs").send({ ...base, i18n: { ko: { ...base.i18n.ko, note: "메모" }, en: base.i18n.en } });
    expect(oneNote.body.error.fields["i18n.en.note"]).toBeTruthy();
    const halfName = await as(admin).post("/v1/admin/collabs").send({ ...base, parties: [{ role: "host", name: { en: "Unknown game" } }] });
    expect(halfName.status).toBe(422);
    const property = await as(admin).post("/v1/admin/properties").send({ slug: "en-only", kind: "partner_category.game", name: { en: "English only" } });
    expect(property.body.error.fields["name.ko"]).toBeTruthy();
  });

  it("refuses to publish incomplete drafts", async () => {
    const { body } = await as(admin)
      .post("/v1/admin/collabs")
      .send({
        i18n: { ko: { title: "미정", summary: "미정" }, en: { title: "TBD", summary: "TBD" } },
        parties: [{ role: "host", name: { ko: "알 수 없는 게임", en: "Unknown game" } }],
        sources: [{ url: "https://example.com/incomplete" }],
      });
    const res = await as(admin).post(`/v1/admin/collabs/${body.data.id}/transition`).send({ action: "publish" });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(["parties", "parties.0.propertyId", "category", "period.start"]));
  });

  it("serves admin tokens (MCP admin tools) with full rights and finds collabs by slug", async () => {
    const adminToken = await apiToken("mcp-admin", "admin");
    const created = await as(adminToken).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id, { sources: [{ url: "https://example.com/by-slug" }], slug: "by-slug-check" }));
    expect(created.status).toBe(201);
    const bySlug = await as(adminToken).get("/v1/admin/collabs/by-slug-check");
    expect(bySlug.body.data).toMatchObject({ id: created.body.data.id, rev: 1 });
    const patched = await as(adminToken).patch("/v1/admin/collabs/by-slug-check").set("if-match", "1").send({ category: "category.brand_campaign" });
    expect(patched.status).toBe(200);
    expect(patched.body.data.rev).toBe(2);
    // A partial PATCH leaves every field it does not send untouched.
    expect(patched.body.data.parties).toHaveLength(2);
    expect(patched.body.data.sources).toHaveLength(1);
    expect(patched.body.data.period.start).toBe(created.body.data.period.start);
    const aliasesBefore = (await Property.findById(e.aot.id).lean())!.aliases;
    expect(aliasesBefore.length).toBeGreaterThan(0);
    await as(adminToken).patch(`/v1/admin/properties/${e.aot.id}`).send({ name: { ko: "진격의 거인", en: "Attack on Titan", original: "進撃の巨人" } });
    expect((await Property.findById(e.aot.id).lean())!.aliases).toEqual(aliasesBefore);
    expect((await as(adminToken).get("/v1/admin/collabs/no-such-slug")).status).toBe(404);
    expect((await as(adminToken).post("/v1/admin/taxonomies").send({ key: "platform.mcp_check", label: { ko: "검사", en: "Check" } })).status).toBe(201);
  });

  it("requires a reason to reject", async () => {
    const { body } = await as(agent).post("/v1/admin/collabs").send(draftBody(e.taiko.id, e.jagariko.id, { sources: [{ url: "https://example.com/rej" }] }));
    expect((await as(editor).post(`/v1/admin/collabs/${body.data.id}/transition`).send({ action: "reject" })).status).toBe(422);
    const res = await as(editor).post(`/v1/admin/collabs/${body.data.id}/transition`).send({ action: "reject", reason: "not a real collab" });
    expect(res.body.data.status).toBe("archived");
    expect(res.body.data.review.rejection.reason).toBe("not a real collab");
  });
});

describe("public API", () => {
  let published: { slug: string };

  beforeAll(async () => {
    await Collab.deleteMany({});
    published = await createAndPublish(draftBody(e.pubg.id, e.aot.id, { sources: [{ url: "https://example.com/pub1" }] }));
    await createAndPublish(
      draftBody(e.taiko.id, e.jagariko.id, {
        slug: "taiko-no-tatsujin-jagariko-2026-10",
        i18n: {
          ko: { title: "태고의 달인 × 자가리코", summary: "아케이드판에 CM 곡 리믹스가 추가된다." },
          en: { title: "Taiko no Tatsujin x Jagariko", summary: "The arcade version adds a remix of the commercial song." },
        },
        category: "category.brand_campaign",
        regions: ["region.japan"],
        platforms: ["platform.arcade"],
        collabTypes: ["collab_type.music"],
        period: { start: "2026-10-05", end: "2027-01-11" },
        sources: [{ url: "https://www.calbee.co.jp/taiko/" }],
        companies: [{ companyId: e.krafton.id, role: "brand_partner" }],
      }),
    );
    // A draft never shows up publicly.
    await as(admin).post("/v1/admin/collabs").send(draftBody(e.blood.id, e.aot.id, { sources: [{ url: "https://example.com/draft-only" }] }));
  });

  it("lists published collabs with parent-key filters (OR within, AND across)", async () => {
    const all = await service().get("/v1/collabs");
    expect(all.body.meta.total).toBe(2);
    const mobile = await service().get("/v1/collabs?platform=platform.mobile");
    expect(mobile.body.data.map((c: { slug: string }) => c.slug)).toEqual([published.slug]);
    const either = await service().get("/v1/collabs?platform=platform.mobile,platform.arcade");
    expect(either.body.meta.total).toBe(2);
    const both = await service().get("/v1/collabs?platform=platform.arcade&region=region.korea");
    expect(both.body.meta.total).toBe(0);
    const asia = await service().get("/v1/collabs?region=region.asia&partner_category=partner_category.f_and_b");
    expect(asia.body.meta.total).toBe(1);
  });

  it("searches Korean and English text", async () => {
    expect((await service().get(`/v1/collabs?q=${encodeURIComponent("진격")}`)).body.meta.total).toBe(1);
    expect((await service().get("/v1/collabs?q=jagari")).body.meta.total).toBe(1);
    expect((await service().get(`/v1/collabs?q=${encodeURIComponent("자가리코 태고")}`)).body.meta.total).toBe(1);
  });

  it("filters by computed phase and period", async () => {
    const ended = await service().get("/v1/collabs?phase=ended");
    const ongoing = await service().get("/v1/collabs?phase=ongoing,upcoming");
    expect(ended.body.meta.total + ongoing.body.meta.total).toBe(2);
    const inSeptember = await service().get("/v1/collabs?from=2026-09-01&to=2026-09-30");
    expect(inSeptember.body.data.map((c: { slug: string }) => c.slug)).toEqual([published.slug]);
  });

  it("paginates with a cursor", async () => {
    const first = await service().get("/v1/collabs?limit=1");
    expect(first.body.data).toHaveLength(1);
    const second = await service().get(`/v1/collabs?limit=1&cursor=${first.body.meta.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].slug).not.toBe(first.body.data[0].slug);
    expect(second.body.meta.nextCursor).toBeNull();
  });

  it("serves each language from its own text", async () => {
    const ko = await service().get("/v1/collabs/taiko-no-tatsujin-jagariko-2026-10?locale=ko");
    expect(ko.status).toBe(200);
    expect(ko.body.data).toMatchObject({ title: "태고의 달인 × 자가리코", category: { key: "category.brand_campaign", label: "브랜드 캠페인" } });
    expect(ko.body.data.parties[1].name).toBe("자가리코");
    expect(ko.body.data.fallback).toBeUndefined();
    const en = await service().get("/v1/collabs/taiko-no-tatsujin-jagariko-2026-10?locale=en");
    expect(en.body.data).toMatchObject({ title: "Taiko no Tatsujin x Jagariko", summary: "The arcade version adds a remix of the commercial song." });
    expect(en.body.data.machineTranslated).toBeUndefined();
    expect(en.body.data.parties[1].name).toBe("Jagariko");
    expect(en.body.data.companies[0]).toMatchObject({ slug: "krafton", role: "brand_partner" });
    expect(en.body.data.review).toBeUndefined();
    expect(en.body.data.rev).toBeUndefined();
    expect(en.body.data.period).toEqual({ start: "2026-10-05", end: "2027-01-11", precision: "day", endKind: "fixed" });
  });

  it("serves entity pages with timeline and partners", async () => {
    const res = await service().get("/v1/properties/attack-on-titan?locale=en");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "Attack on Titan", collabCount: 1, kind: { label: "Anime / Manga" } });
    expect(res.body.data.collabs).toHaveLength(1);
    expect(res.body.data.partners[0]).toMatchObject({ slug: "pubg-mobile", count: 1 });
    expect((await service().get("/v1/companies/krafton")).body.data.collabs).toHaveLength(1);
    expect((await service().get("/v1/properties/nope")).status).toBe(404);
  });

  it("returns stats", async () => {
    const stats = await service().get("/v1/stats?locale=en");
    expect(stats.body.data.total).toBe(2);
    expect(stats.body.data.monthly).toEqual([
      { month: "2026-09", count: 1 },
      { month: "2026-10", count: 1 },
    ]);
    expect(stats.body.data.partnerCategory).toEqual(
      expect.arrayContaining([{ key: "partner_category.f_and_b", label: "Food & beverage", count: 1 }]),
    );
  });

  it("ranks entities and lists years in stats", async () => {
    const all = (await service().get("/v1/stats?locale=en")).body.data;
    expect(all.year).toBeNull();
    expect(all.undated).toBe(0);
    expect(all.years).toEqual([{ year: 2026, count: 2 }]);
    expect(all.topPartners).toEqual(
      expect.arrayContaining([{ slug: "attack-on-titan", name: "Attack on Titan", kind: { key: "partner_category.anime_manga", label: expect.any(String) }, count: 1 }]),
    );
    expect(all.topHosts.map((h: { slug: string }) => h.slug)).toContain("pubg-mobile");
    expect(all.topCompanies.brand_partner).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "krafton", count: 1 })]));
    expect(all.topCompanies.unspecified).toBeUndefined();

    // A year narrows everything but the list of years.
    const y2026 = (await service().get("/v1/stats?year=2026")).body.data;
    expect(y2026).toMatchObject({ year: 2026, total: 2, years: all.years });
    const y2025 = (await service().get("/v1/stats?year=2025")).body.data;
    expect(y2025).toMatchObject({ year: 2025, total: 0, monthly: [], topHosts: [], years: all.years });
    expect((await service().get("/v1/stats?year=1999")).status).toBe(422);
  });

  it("counts collabs by phase in stats", async () => {
    const stats = await service().get("/v1/stats");
    const byPhase = stats.body.data.byPhase;
    expect(Object.keys(byPhase).sort()).toEqual(["ended", "ongoing", "unknown", "upcoming"]);
    expect(byPhase.upcoming + byPhase.ongoing + byPhase.ended + byPhase.unknown).toBe(2);
  });

  it("sorts by publication for feeds and exposes publishedAt on cards", async () => {
    const res = await service().get("/v1/collabs?sort=recent&limit=1");
    expect(res.body.data[0].slug).toBe("taiko-no-tatsujin-jagariko-2026-10");
    expect(res.body.data[0].publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const next = await service().get(`/v1/collabs?sort=recent&limit=1&cursor=${res.body.meta.nextCursor}`);
    expect(next.body.data[0].slug).toBe(published.slug);
  });

  it("gives each collab's role on company pages", async () => {
    const res = await service().get("/v1/companies/krafton");
    expect(res.body.data.collabs[0].companyRole).toBe("brand_partner");
    expect((await service().get("/v1/properties/attack-on-titan")).body.data.collabs[0].companyRole).toBeUndefined();
  });

  it("lists published collabs and their entities for the sitemap", async () => {
    const res = await service().get("/v1/sitemap");
    expect(res.status).toBe(200);
    // Entity pages change when one of their collabs changes: updatedAt is at least the newest collab's.
    const latestCollab = Math.max(...res.body.data.collabs.map((c: { updatedAt: string }) => Date.parse(c.updatedAt)));
    const krafton = res.body.data.companies.find((c: { slug: string }) => c.slug === "krafton");
    expect(Date.parse(krafton.updatedAt)).toBeGreaterThan(0);
    for (const p of res.body.data.properties) expect(p.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const aot = res.body.data.properties.find((p: { slug: string }) => p.slug === "attack-on-titan");
    expect(Date.parse(aot.updatedAt)).toBeLessThanOrEqual(Math.max(latestCollab, Date.now()));
    expect(res.body.data.collabs.map((c: { slug: string }) => c.slug).sort()).toEqual([published.slug, "taiko-no-tatsujin-jagariko-2026-10"].sort());
    expect(res.body.data.properties.map((p: { slug: string }) => p.slug)).toEqual(expect.arrayContaining(["attack-on-titan", "pubg-mobile"]));
    expect(res.body.data.properties.map((p: { slug: string }) => p.slug)).not.toContain("blood-strike");
    expect(res.body.data.companies).toEqual([{ slug: "krafton", updatedAt: expect.any(String) }]);
  });

  it("gives the admin queue status counts and duplicate flags", async () => {
    const res = await as(admin).get("/v1/admin/collabs?status=draft,in_review");
    expect(res.body.meta.counts).toMatchObject({ published: 2, draft: 1, in_review: 0, archived: 0 });
    expect(res.body.data[0].duplicateCount).toBe(0);
  });

  it("stores venues for offline collabs and serves them per language", async () => {
    const venues = [
      { name: { ko: "로운드원 시부야점", en: "ROUND1 Shibuya" }, address: "東京都渋谷区宇田川町", url: "https://www.round1.co.jp/shop/tenpo/tokyo-shibuya.html" },
      { name: { ko: "전국 매장", en: "All stores" } },
    ];
    const created = await as(admin).post("/v1/admin/collabs").send(draftBody(e.taiko.id, e.jagariko.id, { sources: [{ url: "https://example.com/venue" }], category: "category.offline_event", venues }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.venues).toEqual([
      { name: venues[0]!.name, address: venues[0]!.address, url: venues[0]!.url },
      { name: venues[1]!.name, address: null, url: null },
    ]);
    // Venue names follow the bilingual rule.
    const bad = await as(admin).patch(`/v1/admin/collabs/${id}`).set("if-match", "1").send({ venues: [{ name: { ko: "매장" } }] });
    expect(bad.status).toBe(422);
    const patched = await as(admin).patch(`/v1/admin/collabs/${id}`).set("if-match", "1").send({ venues: [venues[0]] });
    expect(patched.body.data.venues).toHaveLength(1);
    expect(patched.body.data.parties).toHaveLength(2);
    await as(admin).post(`/v1/admin/collabs/${id}/transition`).send({ action: "publish" });
    const slug = created.body.data.slug;
    const en = await service().get(`/v1/collabs/${slug}?locale=en`);
    expect(en.body.data.venues).toEqual([{ name: "ROUND1 Shibuya", address: venues[0]!.address, url: venues[0]!.url }]);
    expect((await service().get(`/v1/collabs/${slug}?locale=ko`)).body.data.venues[0].name).toBe("로운드원 시부야점");
    await Collab.deleteOne({ _id: id });
  });

  it("returns the taxonomy tree", async () => {
    const res = await service().get("/v1/taxonomies?locale=en");
    const mobile = res.body.data.platform.find((t: { key: string }) => t.key === "platform.mobile");
    expect(mobile.children.map((c: { key: string }) => c.key)).toEqual(["platform.android", "platform.ios"]);
  });
});

describe("entities", () => {
  it("propagates renames to collab snapshots and search", async () => {
    const res = await as(admin).patch(`/v1/admin/properties/${e.jagariko.id}`).send({ name: { ko: "자가리코", en: "Jagarico" }, slug: "jagarico" });
    expect(res.status).toBe(200);
    const c = await Collab.findOne({ "parties.propertyId": e.jagariko._id }).select("+searchTokens").lean();
    expect(c!.parties[1]).toMatchObject({ slug: "jagarico", name: { ko: "자가리코", en: "Jagarico" } });
    expect(c!.searchTokens).toContain("jagarico");
    // The old slug still resolves.
    const page = await service().get("/v1/properties/jagariko");
    expect(page.body.data.slug).toBe("jagarico");
  });

  it("autocompletes and merges entities", async () => {
    const dup = await as(admin).post("/v1/admin/properties").send({ slug: "shingeki", kind: "partner_category.anime_manga", name: { ko: "싱게키", en: "Shingeki" } });
    expect(dup.status).toBe(201);
    const target = await Property.findById(e.aot.id);
    const hits = await as(editor).get(`/v1/admin/properties?q=${encodeURIComponent("진격의 거인")}`);
    expect(hits.body.data[0]).toMatchObject({ slug: "attack-on-titan", exact: true });

    const draft = await as(admin).post("/v1/admin/collabs").send(draftBody(e.blood.id, dup.body.data._id, { sources: [{ url: "https://example.com/merge" }] }));
    expect((await as(editor).post(`/v1/admin/properties/${target!.id}/merge`).send({ from: dup.body.data._id })).status).toBe(403);
    const merged = await as(admin).post(`/v1/admin/properties/${target!.id}/merge`).send({ from: dup.body.data._id });
    expect(merged.status).toBe(200);
    expect(merged.body.data.aliases).toContain("Shingeki");
    expect(merged.body.data.formerSlugs).toContain("shingeki");
    const after = await Collab.findById(draft.body.data.id).lean();
    expect(after!.parties[1]!.propertyId!.toString()).toBe(target!.id);
    expect(await Property.exists({ _id: dup.body.data._id })).toBeNull();
  });

  it("lists every entity when no query is given", async () => {
    const res = await as(editor).get("/v1/admin/companies");
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { slug: string }) => c.slug)).toContain("krafton");
  });

  it("matches names for agents", async () => {
    const res = await as(agent).get("/v1/admin/match?name=PUBG%20M");
    expect(res.body.data.properties[0]).toMatchObject({ slug: "pubg-mobile", exact: true });
  });
});

describe("taxonomy admin", () => {
  it("only admins add terms, with ancestors computed", async () => {
    const body = { key: "platform.galaxy_store", parent: "platform.android", label: { ko: "갤럭시 스토어", en: "Galaxy Store" } };
    expect((await as(editor).post("/v1/admin/taxonomies").send(body)).status).toBe(403);
    const res = await as(admin).post("/v1/admin/taxonomies").send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.ancestors).toEqual(["platform.mobile", "platform.android"]);
    expect((await as(admin).post("/v1/admin/taxonomies").send(body)).status).toBe(409);
  });
});

describe("submissions", () => {
  const visitor = (ip: string) => ({ post: (url: string) => service().post(url).set("x-client-ip", ip) });

  it("queues tips once per open url and lists them for admins", async () => {
    const tip = { url: "https://example.com/news/new-collab?utm_source=x", note: "new one", locale: "ko" };
    expect((await visitor("10.0.0.1").post("/v1/submissions").send(tip)).status).toBe(202);
    expect((await visitor("10.0.0.1").post("/v1/submissions").send(tip)).status).toBe(202);
    const res = await as(admin).get("/v1/admin/submissions?kind=tip&status=new");
    expect(res.status).toBe(200);
    const rows = res.body.data.filter((s: { url: string }) => s.url.startsWith("https://example.com/news/new-collab"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tip", status: "new", note: "new one", collab: null });
    expect(res.body.meta.counts.tip).toBeGreaterThanOrEqual(1);
    expect((await visitor("10.0.0.1").post("/v1/submissions").send({ note: "no url" })).status).toBe(422);
    expect((await visitor("10.0.0.1").post("/v1/submissions").send({ ...tip, website: "spam" })).status).toBe(422);
  });

  it("links corrections to a published collab", async () => {
    const collab = await createAndPublish(
      draftBody(e.blood.id, e.aot.id, { sources: [{ url: "https://example.com/blood-report" }], period: { start: "2026-03-01", end: "2026-03-31" } }),
    );
    const report = { kind: "correction", collab: collab.slug, note: "The end date was announced as 3/31.", locale: "en" };
    expect((await visitor("10.0.0.2").post("/v1/submissions").send(report)).status).toBe(202);
    expect((await visitor("10.0.0.2").post("/v1/submissions").send({ ...report, note: "bad" })).status).toBe(422);
    expect((await visitor("10.0.0.2").post("/v1/submissions").send({ ...report, collab: "no-such-collab" })).status).toBe(404);

    const list = await as(editor).get("/v1/admin/submissions?kind=correction");
    const row = list.body.data.find((s: { collab: { slug: string } | null }) => s.collab?.slug === collab.slug);
    expect(row).toMatchObject({ kind: "correction", url: null, note: report.note, collab: { id: collab.id, status: "published" } });
    expect(row.collab.title.ko).toBeTruthy();

    const done = await as(editor).patch(`/v1/admin/submissions/${row.id}`).send({ status: "accepted" });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ id: row.id, status: "accepted", collab: { slug: collab.slug } });
    expect((await service().get("/v1/admin/submissions")).status).toBe(403);
  });
});
