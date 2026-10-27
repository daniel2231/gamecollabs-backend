import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Records the cache tags the API asks the web app to drop.
const revalidated: string[][] = [];
vi.mock("../src/lib/outbound.js", () => ({
  revalidate: (tags: Iterable<string>) => revalidated.push([...tags]),
  notify: () => {},
}));

const { SERVICE_TOKEN, adminJwt, apiToken, as, setupDb, teardownDb } = await import("./helpers.js");

let admin: string;
let editor: string;
const service = () => as(SERVICE_TOKEN);
const tags = () => revalidated.flat();

beforeAll(async () => {
  await setupDb();
  admin = await adminJwt("daniel", "admin");
  editor = await adminJwt("eddie", "editor");
});
afterAll(teardownDb);
beforeEach(() => {
  revalidated.length = 0;
});

const entry = (version: string, date: string, published = true) => ({
  version,
  date,
  body: { ko: `- ${version} 변경 사항`, en: `- Changes in ${version}` },
  published,
});

describe("changelog", () => {
  it("creates entries, lists published ones newest first in the requested language", async () => {
    for (const body of [entry("1.0.0", "2026-09-01"), entry("1.1.0", "2026-10-15"), entry("1.2.0", "2026-11-01", false)]) {
      const res = await as(admin).post("/v1/admin/changelog").send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ version: body.version, date: body.date, body: body.body, published: body.published });
    }
    // The draft does not touch the public page.
    expect(revalidated).toEqual([["changelog"], ["changelog"]]);

    const en = await service().get("/v1/changelog?locale=en");
    expect(en.status).toBe(200);
    expect(en.body.data.map((e: { version: string }) => e.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(en.body.data[0]).toEqual({ id: expect.any(String), version: "1.1.0", date: "2026-10-15", body: "- Changes in 1.1.0" });

    const ko = await service().get("/v1/changelog");
    expect(ko.body.data[0].body).toBe("- 1.1.0 변경 사항");

    const all = await as(admin).get("/v1/admin/changelog");
    expect(all.body.data.map((e: { version: string }) => e.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  it("patches only the given fields and revalidates when the entry is or was public", async () => {
    const all = await as(admin).get("/v1/admin/changelog");
    const draft = all.body.data.find((e: { version: string }) => e.version === "1.2.0");

    let res = await as(admin).patch(`/v1/admin/changelog/${draft.id}`).send({ body: { ko: "수정", en: "Edited" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ version: "1.2.0", date: "2026-11-01", body: { ko: "수정", en: "Edited" }, published: false });
    expect(tags()).toEqual([]);

    res = await as(admin).patch(`/v1/admin/changelog/${draft.id}`).send({ published: true, date: "2026-10-20" });
    expect(res.body.data).toMatchObject({ published: true, date: "2026-10-20" });
    expect(tags()).toEqual(["changelog"]);

    const pub = await service().get("/v1/changelog?locale=en");
    expect(pub.body.data[0]).toMatchObject({ version: "1.2.0", body: "Edited" });
  });

  it("deletes entries", async () => {
    const created = await as(admin).post("/v1/admin/changelog").send(entry("0.9.0", "2026-08-01"));
    revalidated.length = 0;
    const res = await as(admin).delete(`/v1/admin/changelog/${created.body.data.id}`);
    expect(res.status).toBe(204);
    expect(tags()).toEqual(["changelog"]);
    expect((await as(admin).delete(`/v1/admin/changelog/${created.body.data.id}`)).status).toBe(404);
    expect((await as(admin).patch("/v1/admin/changelog/not-an-id").send({ published: false })).status).toBe(404);
  });

  it("validates input and rejects a duplicate version", async () => {
    const dup = await as(admin).post("/v1/admin/changelog").send(entry("1.0.0", "2026-09-02"));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("duplicate_key");

    const bad = await as(admin)
      .post("/v1/admin/changelog")
      .send({ version: "1 0", date: "2026-02-30", body: { ko: "내용", en: " " } });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(["version", "date", "body.en"]));
  });

  it("is written by admins only", async () => {
    expect((await as(editor).get("/v1/admin/changelog")).status).toBe(403);
    expect((await as(editor).post("/v1/admin/changelog").send(entry("3.0.0", "2026-10-01"))).status).toBe(403);
    expect((await service().post("/v1/admin/changelog").send(entry("3.0.0", "2026-10-01"))).status).toBe(403);
    const agent = await apiToken("bot", "agent");
    expect((await as(agent).post("/v1/admin/changelog").send(entry("3.0.0", "2026-10-01"))).status).toBe(403);
  });
});
