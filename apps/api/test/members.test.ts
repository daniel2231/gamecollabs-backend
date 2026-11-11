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
