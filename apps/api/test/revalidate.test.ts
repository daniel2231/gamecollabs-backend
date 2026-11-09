import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Records the cache tags the API asks the web app to drop.
const revalidated: string[][] = [];
vi.mock("../src/lib/outbound.js", () => ({
  revalidate: (tags: Iterable<string>) => revalidated.push([...tags]),
  notify: () => {},
}));

const { adminJwt, as, draftBody, seedEntities, setupDb, teardownDb } = await import("./helpers.js");
const { phaseRollover } = await import("../src/jobs/tasks.js");

let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;
const tags = () => revalidated.flat();

beforeAll(async () => {
  await setupDb();
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

// The web app's detail pages listen only to their own tag, so every page showing the collab must be named.
describe("revalidate tags for detail pages", () => {
  it("names the pages of the parties and companies a collab is moved away from", async () => {
    const doc = await publish(
      draftBody(e.pubg.id, e.aot.id, { companies: [{ companyId: e.krafton.id, role: "publisher" }] }),
    );
    revalidated.length = 0;

    const res = await as(admin)
      .patch(`/v1/admin/collabs/${doc.id}`)
      .set("if-match", String(doc.rev))
      .send({
        parties: [
          { propertyId: e.blood.id, role: "host" },
          { propertyId: e.aot.id, role: "partner" },
        ],
        companies: [],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tags()).toEqual(
      expect.arrayContaining([
        "collabs",
        `collab:${doc.slug}`,
        "property:pubg-mobile",
        "property:blood-strike",
        "property:attack-on-titan",
        "company:krafton",
      ]),
    );
  });

  it("phase rollover names collabs that started or ended in the last day, with their parties", async () => {
    const now = new Date();
    const day = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
    const started = await publish(draftBody(e.taiko.id, e.jagariko.id, { period: { start: day(0), end: day(10) } }));
    const later = await publish(
      draftBody(e.blood.id, e.jagariko.id, {
        i18n: {
          ko: { title: "블러드 스트라이크 × 자가리코", summary: "자가리코 콜라보가 열린다." },
          en: { title: "Blood Strike x Jagariko", summary: "A Jagariko collab opens." },
        },
        period: { start: day(5), end: day(10) },
      }),
    );
    revalidated.length = 0;

    const result = await phaseRollover(new Date(now.getTime() + 60_000));
    expect(result.changed).toBeGreaterThanOrEqual(1);
    expect(tags()).toEqual(expect.arrayContaining([`collab:${started.slug}`, "property:taiko-no-tatsujin", "property:jagariko"]));
    expect(tags()).not.toContain(`collab:${later.slug}`);
  });
});
