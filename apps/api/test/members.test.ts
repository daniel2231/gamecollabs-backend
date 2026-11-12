import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bookmark, Member } from "../src/models/member.js";
import { SERVICE_TOKEN, adminJwt, as, draftBody, memberJwt, seedEntities, setupDb, teardownDb } from "./helpers.js";

let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;
const service = () => as(SERVICE_TOKEN);
const discordId = "123456789012345678";

beforeAll(async () => {
  await setupDb();
  admin = await adminJwt("daniel", "admin");
  e = await seedEntities();
});
afterAll(teardownDb);

async function publish(body: ReturnType<typeof draftBody>) {
  const created = await as(admin).post("/v1/admin/collabs").send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await as(admin).post(`/v1/admin/collabs/${created.body.data.id}/transition`).send({ action: "publish" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; slug: string };
}

async function login(id = discordId, username = "tester") {
  const res = await service().post("/v1/members/discord").send({ discordId: id, username, globalName: "Tester", avatar: "a_0123456789abcdef0123456789abcdef" });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { member: res.body.data, token: await memberJwt(res.body.data.id), status: res.status };
}

describe("members", () => {
  it("creates a member on first login and refreshes the profile afterwards", async () => {
    const first = await login(discordId, "old-name");
    expect(first.status).toBe(201);
    const again = await login(discordId, "new-name");
    expect(again.status).toBe(200);
    expect(again.member.id).toBe(first.member.id);
    expect(again.member.username).toBe("new-name");
    expect(await Member.countDocuments({ discordId })).toBe(1);
  });

  it("only lets the service token create members", async () => {
    const body = { discordId: "223456789012345678", username: "x" };
    expect((await as(admin).post("/v1/members/discord").send({ ...body })).status).toBe(201); // admin has every scope
    const { token } = await login();
    expect((await as(token).post("/v1/members/discord").send(body)).status).toBe(403);
    expect((await service().post("/v1/members/discord").send({ discordId: "abc", username: "x" })).status).toBe(422);
  });

  it("keeps member and staff tokens apart", async () => {
    const { token } = await login();
    expect((await as(token).get("/v1/me")).status).toBe(200);
    expect((await as(token).get("/v1/admin/collabs")).status).toBe(403);
    expect((await as(token).get("/v1/collabs")).status).toBe(403);
    expect((await as(admin).get("/v1/me")).status).toBe(403);
    expect((await service().get("/v1/me")).status).toBe(403);
    // A member token cannot pose as a staff login, and the wrong scope claim is refused
    const { member } = await login();
    expect((await as(await memberJwt(member.id, { audience: "gamecollabs-api" })).get("/v1/admin/collabs")).status).toBe(401);
    expect((await as(await memberJwt(member.id, { scope: "admin" })).get("/v1/me")).status).toBe(401);
    expect((await as(await memberJwt("000000000000000000000000")).get("/v1/me")).status).toBe(401);
  });

  it("refuses disabled members at login and on open sessions", async () => {
    const id = "323456789012345678";
    const { token } = await login(id);
    await Member.updateOne({ discordId: id }, { active: false });
    expect((await as(token).get("/v1/me")).status).toBe(401);
    const res = await service().post("/v1/members/discord").send({ discordId: id, username: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("member_disabled");
  });
});

describe("bookmarks", () => {
  it("saves, lists and removes published collabs", async () => {
    const one = await publish(draftBody(e.pubg.id, e.aot.id, { sources: [{ url: "https://example.com/bm-one" }] }));
    const two = await publish(draftBody(e.blood.id, e.aot.id, { period: { start: "2026-08-01", end: "2026-08-31" }, sources: [{ url: "https://example.com/bm-two" }] }));
    const { token } = await login("423456789012345678");
    const me = as(token);

    expect((await me.get(`/v1/me/bookmarks/${one.slug}`)).body.data.bookmarked).toBe(false);
    expect((await me.put(`/v1/me/bookmarks/${one.slug}`)).body.data.bookmarked).toBe(true);
    expect((await me.put(`/v1/me/bookmarks/${one.slug}`)).status).toBe(200); // idempotent
    expect((await me.put(`/v1/me/bookmarks/${two.slug}`)).status).toBe(200);
    expect((await me.get(`/v1/me/bookmarks/${one.slug}`)).body.data.bookmarked).toBe(true);
    expect((await me.put("/v1/me/bookmarks/no-such-collab")).status).toBe(404);

    const list = await me.get("/v1/me/bookmarks?locale=en&limit=1");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].slug).toBe(two.slug); // newest first
    expect(list.body.data[0].bookmarkedAt).toEqual(expect.any(String));
    const next = await me.get(`/v1/me/bookmarks?locale=en&limit=1&cursor=${list.body.meta.nextCursor}`);
    expect(next.body.data.map((c: { slug: string }) => c.slug)).toEqual([one.slug]);
    expect(next.body.meta.nextCursor).toBeNull();

    expect((await me.get("/v1/me")).body.data.bookmarkCount).toBe(2);
    expect((await me.delete(`/v1/me/bookmarks/${one.slug}`)).body.data.bookmarked).toBe(false);
    expect((await me.get("/v1/me/bookmarks")).body.data.map((c: { slug: string }) => c.slug)).toEqual([two.slug]);
  });

  it("hides collabs that are no longer published", async () => {
    const collab = await publish(draftBody(e.taiko.id, e.jagariko.id, { sources: [{ url: "https://example.com/bm-archived" }] }));
    const { token } = await login("523456789012345678");
    await as(token).put(`/v1/me/bookmarks/${collab.slug}`);
    const archived = await as(admin).post(`/v1/admin/collabs/${collab.id}/transition`).send({ action: "archive" });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const list = await as(token).get("/v1/me/bookmarks");
    expect(list.body.data).toEqual([]);
    expect(list.body.meta.total).toBe(0);
    // It can still be removed
    expect((await as(token).delete(`/v1/me/bookmarks/${collab.slug}`)).status).toBe(200);
  });

  it("deletes the account with its bookmarks", async () => {
    const collab = await publish(draftBody(e.pubg.id, e.jagariko.id, { sources: [{ url: "https://example.com/bm-delete" }] }));
    const { member, token } = await login("623456789012345678");
    await as(token).put(`/v1/me/bookmarks/${collab.slug}`);
    expect((await as(token).delete("/v1/me")).status).toBe(204);
    expect(await Bookmark.countDocuments({ memberId: member.id })).toBe(0);
    expect((await as(token).get("/v1/me")).status).toBe(401);
  });
});

describe("follows and feed", () => {
  it("follows properties and companies and builds a feed of their published collabs", async () => {
    const viaProperty = await publish(draftBody(e.blood.id, e.taiko.id, { sources: [{ url: "https://example.com/feed-prop" }] }));
    const viaCompany = await publish(
      draftBody(e.jagariko.id, e.pubg.id, { sources: [{ url: "https://example.com/feed-company" }], companies: [{ companyId: e.krafton.id, role: "publisher" }] }),
    );
    const { token } = await login("723456789012345678");
    const me = as(token);

    expect((await me.get("/v1/me/feed")).body).toMatchObject({ data: [], meta: { total: 0, nextCursor: null } });
    expect((await me.put("/v1/me/follows/property/blood-strike")).body.data.following).toBe(true);
    expect((await me.put("/v1/me/follows/property/blood-strike")).status).toBe(200); // idempotent
    expect((await me.put("/v1/me/follows/company/krafton")).status).toBe(200);
    expect((await me.put("/v1/me/follows/property/no-such-thing")).status).toBe(404);
    expect((await me.put("/v1/me/follows/planet/krafton")).status).toBe(422);
    expect((await me.get("/v1/me/follows/company/krafton")).body.data.following).toBe(true);

    const follows = await me.get("/v1/me/follows?locale=en");
    expect(follows.body.data.map((f: { type: string; slug: string }) => `${f.type}:${f.slug}`)).toEqual(["company:krafton", "property:blood-strike"]);
    expect(follows.body.data[1].name).toBe("Blood Strike");

    const feed = await me.get("/v1/me/feed?limit=1");
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(feed.body.meta.total).toBeGreaterThanOrEqual(2);
    const all = [...feed.body.data];
    let cursor = feed.body.meta.nextCursor;
    while (cursor) {
      const next = await me.get(`/v1/me/feed?limit=1&cursor=${cursor}`);
      all.push(...next.body.data);
      cursor = next.body.meta.nextCursor;
    }
    const slugs = all.map((c: { slug: string }) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining([viaProperty.slug, viaCompany.slug]));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toHaveLength(feed.body.meta.total);

    const state = await me.get("/v1/me/state");
    expect(state.body.data.follows).toEqual({ property: ["blood-strike"], company: ["krafton"] });
    expect((await me.get("/v1/me")).body.data.followCount).toBe(2);

    expect((await me.delete("/v1/me/follows/company/krafton")).body.data.following).toBe(false);
    expect((await me.get("/v1/me/state")).body.data.follows.company).toEqual([]);
  });

  it("lists saved collab slugs in the state", async () => {
    const collab = await publish(draftBody(e.blood.id, e.jagariko.id, { sources: [{ url: "https://example.com/state-bm" }] }));
    const { token } = await login("823456789012345678");
    await as(token).put(`/v1/me/bookmarks/${collab.slug}`);
    expect((await as(token).get("/v1/me/state")).body.data.bookmarks).toEqual([collab.slug]);
  });

  it("moves follows to the surviving entity when entities are merged", async () => {
    const [keep, absorb] = await Promise.all([
      as(admin).post("/v1/admin/properties").send({ slug: "merge-keep", kind: "partner_category.game", name: { ko: "남는 작품", en: "Kept" } }),
      as(admin).post("/v1/admin/properties").send({ slug: "merge-absorb", kind: "partner_category.game", name: { ko: "흡수 작품", en: "Absorbed" } }),
    ]);
    expect(keep.status, JSON.stringify(keep.body)).toBe(201);
    const both = await login("923456789012345678");
    const onlyAbsorbed = await login("993456789012345678");
    await as(both.token).put("/v1/me/follows/property/merge-keep");
    await as(both.token).put("/v1/me/follows/property/merge-absorb");
    await as(onlyAbsorbed.token).put("/v1/me/follows/property/merge-absorb");

    const merged = await as(admin).post(`/v1/admin/properties/${keep.body.data._id}/merge`).send({ from: absorb.body.data._id });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    expect((await as(both.token).get("/v1/me/state")).body.data.follows.property).toEqual(["merge-keep"]);
    expect((await as(onlyAbsorbed.token).get("/v1/me/state")).body.data.follows.property).toEqual(["merge-keep"]);
    // The former slug still resolves
    expect((await as(onlyAbsorbed.token).get("/v1/me/follows/property/merge-absorb")).body.data.following).toBe(true);
  });
});
