import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Records the cache tags the API asks the web app to drop.
const revalidated: string[][] = [];
vi.mock("../src/lib/outbound.js", () => ({
  revalidate: (tags: Iterable<string>) => revalidated.push([...tags]),
  notify: () => {},
}));

const { SERVICE_TOKEN, adminJwt, as, draftBody, seedEntities, setupDb, teardownDb } = await import("./helpers.js");
const { Property } = await import("../src/models/entities.js");

let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;
const service = () => as(SERVICE_TOKEN);
const tags = () => revalidated.flat();

beforeAll(async () => {
  await setupDb({ MEDIA_BASE_URL: "https://media.example.com" });
  admin = await adminJwt("daniel", "admin");
  e = await seedEntities();
});
afterAll(teardownDb);
beforeEach(() => {
  revalidated.length = 0;
});

async function publish(body: Record<string, unknown>) {
  const created = await as(admin).post("/v1/admin/collabs").send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const published = await as(admin).post(`/v1/admin/collabs/${created.body.data.id}/transition`).send({ action: "publish" });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body.data;
}

const image = {
  storageKey: "covers/aot.webp",
  credit: "© Hajime Isayama",
  alt: { ko: "진격의 거인 대표 이미지", en: "Attack on Titan key art" },
  width: 1200,
  height: 1200,
};

describe("admin: featuredOrder and image", () => {
  it("saves both fields, returns the image like a collab cover and sends the featured tag", async () => {
    const res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ featuredOrder: 1, image });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      featuredOrder: 1,
      image: { ...image, url: "https://media.example.com/covers/aot.webp", originalUrl: null },
    });
    expect(tags()).toEqual(expect.arrayContaining(["featured", "property:attack-on-titan"]));
  });

  it("keeps omitted fields, and clears them with null", async () => {
    let res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ aliases: ["AoT"] });
    expect(res.body.data).toMatchObject({ featuredOrder: 1, image: { storageKey: "covers/aot.webp" } });
    expect(tags()).not.toContain("featured");

    res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ featuredOrder: null, image: null });
    expect(res.body.data).toMatchObject({ featuredOrder: null, image: null });
    expect(tags()).toContain("featured");
  });

  it("validates featuredOrder (1–999 integer) and image (storageKey or originalUrl)", async () => {
    for (const featuredOrder of [0, 1000, 1.5, "1"]) {
      const res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ featuredOrder });
      expect(res.status).toBe(422);
      expect(res.body.error.fields.featuredOrder).toBeDefined();
    }
    let res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ image: { credit: "x" } });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.image).toEqual(["either storageKey or originalUrl is required"]);
    res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ image: { originalUrl: "ftp://x.example.com/a.png" } });
    expect(res.status).toBe(422);
    expect(res.body.error.fields["image.originalUrl"]).toBeDefined();
  });

  it("accepts both fields on create and lists them in search results", async () => {
    const res = await as(admin)
      .post("/v1/admin/properties")
      .send({ slug: "one-piece", kind: "partner_category.anime_manga", name: { ko: "원피스", en: "One Piece" }, featuredOrder: 5, image: { originalUrl: "https://example.com/op.png" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ featuredOrder: 5, image: { storageKey: null, url: "https://example.com/op.png", originalUrl: "https://example.com/op.png", alt: null } });
    expect(tags()).toEqual(expect.arrayContaining(["featured", "property:one-piece"]));

    const plain = await as(admin).post("/v1/admin/properties").send({ slug: "naruto", kind: "partner_category.anime_manga", name: { ko: "나루토", en: "Naruto" } });
    expect(plain.body.data).toMatchObject({ featuredOrder: null, image: null });

    const list = await as(admin).get("/v1/admin/properties");
    expect(list.body.data.find((p: { slug: string }) => p.slug === "one-piece")).toMatchObject({ featuredOrder: 5, image: { url: "https://example.com/op.png" } });
    expect(list.body.data.find((p: { slug: string }) => p.slug === "naruto")).toMatchObject({ featuredOrder: null, image: null });
    const match = await as(admin).get(`/v1/admin/match?name=${encodeURIComponent("원피스")}`);
    expect(match.body.data.properties[0]).toMatchObject({ slug: "one-piece", featuredOrder: 5 });
    expect(match.body.data.companies.every((c: object) => !("featuredOrder" in c))).toBe(true);
  });

  it("merge keeps the target's values and takes the absorbed property's only where the target has none", async () => {
    const make = (slug: string, extra: Record<string, unknown>) =>
      as(admin).post("/v1/admin/properties").send({ slug, kind: "partner_category.game", name: { ko: slug, en: slug }, ...extra });
    const target = (await make("merge-target", { featuredOrder: 7 })).body.data;
    const from = (await make("merge-from", { featuredOrder: 2, image: { storageKey: "covers/from.webp" } })).body.data;
    revalidated.length = 0;
    const res = await as(admin).post(`/v1/admin/properties/${target._id}/merge`).send({ from: from._id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ featuredOrder: 7, image: { storageKey: "covers/from.webp", url: "https://media.example.com/covers/from.webp" } });
    expect(tags()).toContain("featured");
    await Property.deleteOne({ _id: target._id });
  });
});

describe("GET /v1/properties?featured=true", () => {
  it("lists featured properties in order with counts over their published collabs", async () => {
    // AoT: ongoing collab with PUBG Mobile (cover, Sep), ended one with Blood Strike (cover, Aug), and a draft.
    await publish(
      draftBody(e.pubg.id, e.aot.id, {
        cover: { storageKey: "covers/sep.webp", credit: "© KRAFTON", alt: { ko: "9월", en: "September" }, width: 1600, height: 900 },
      }),
    );
    await publish(
      draftBody(e.blood.id, e.aot.id, {
        i18n: {
          ko: { title: "블러드 스트라이크 × 진격의 거인", summary: "요약" },
          en: { title: "Blood Strike x Attack on Titan", summary: "Summary" },
        },
        period: { start: "2026-08-01", end: "2026-08-31" },
        sources: [{ url: "https://example.com/blood-aot" }],
        cover: { originalUrl: "https://example.com/aug.png" },
      }),
    );
    await as(admin).post("/v1/admin/collabs").send(draftBody(e.taiko.id, e.aot.id, { sources: [{ url: "https://example.com/draft" }] }));

    await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ featuredOrder: 3, image });
    await as(admin).patch(`/v1/admin/properties/${e.pubg.id}`).send({ featuredOrder: 3 });
    await as(admin).patch(`/v1/admin/properties/${e.jagariko.id}`).send({ featuredOrder: 1 });

    const ko = await service().get("/v1/properties?featured=true&locale=ko");
    expect(ko.status, JSON.stringify(ko.body)).toBe(200);
    // 1: jagariko, then the two 3s by Korean name (배틀그라운드 모바일 < 진격의 거인), then one-piece (5).
    expect(ko.body.data.map((p: { slug: string }) => p.slug)).toEqual(["jagariko", "pubg-mobile", "attack-on-titan", "one-piece"]);

    const aot = ko.body.data[2];
    expect(aot).toEqual({
      slug: "attack-on-titan",
      name: "진격의 거인",
      names: { ko: "진격의 거인", en: "Attack on Titan", original: "進撃の巨人" },
      kind: { key: "partner_category.anime_manga", label: expect.any(String) },
      collabCount: 2,
      counterpartCount: 2,
      ongoingCount: 1,
      image: { url: "https://media.example.com/covers/aot.webp", credit: "© Hajime Isayama", alt: "진격의 거인 대표 이미지" },
      latestCover: { url: "https://media.example.com/covers/sep.webp", originalUrl: null, credit: "© KRAFTON", alt: "9월", width: 1600, height: 900 },
    });
    expect(ko.body.data[0]).toMatchObject({ slug: "jagariko", collabCount: 0, counterpartCount: 0, ongoingCount: 0, image: null, latestCover: null });
    expect(ko.body.data[1]).toMatchObject({ slug: "pubg-mobile", collabCount: 1, counterpartCount: 1, ongoingCount: 1 });

    const en = await service().get("/v1/properties?featured=true&locale=en");
    // In English the 3s order by English name: Attack on Titan < PUBG Mobile.
    expect(en.body.data.map((p: { slug: string }) => p.slug)).toEqual(["jagariko", "attack-on-titan", "pubg-mobile", "one-piece"]);
    expect(en.body.data[1]).toMatchObject({ name: "Attack on Titan", image: { alt: "Attack on Titan key art" }, latestCover: { alt: "September" } });
  });

  it("gives null alt when none is stored, and requires featured=true", async () => {
    const res = await service().get("/v1/properties?featured=true");
    expect(res.body.data.find((p: { slug: string }) => p.slug === "one-piece").image).toEqual({ url: "https://example.com/op.png", credit: null, alt: null });
    expect((await service().get("/v1/properties")).status).toBe(422);
  });
});
