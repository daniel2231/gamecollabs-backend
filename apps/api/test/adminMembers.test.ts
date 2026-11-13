import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Member } from "../src/models/member.js";
import { SERVICE_TOKEN, adminJwt, as, draftBody, memberJwt, seedEntities, setupDb, teardownDb } from "./helpers.js";

let admin: string;
let editor: string;
let e: Awaited<ReturnType<typeof seedEntities>>;

beforeAll(async () => {
  await setupDb();
  admin = await adminJwt("daniel", "admin");
  editor = await adminJwt("helper", "editor");
  e = await seedEntities();
});
afterAll(teardownDb);

async function login(discordId: string, username: string) {
  const res = await as(SERVICE_TOKEN).post("/v1/members/discord").send({ discordId, username, globalName: null, avatar: null });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { id: res.body.data.id as string, token: await memberJwt(res.body.data.id) };
}

async function publish(source: string) {
  const created = await as(admin).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id, { sources: [{ url: source }] }));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const res = await as(admin).post(`/v1/admin/collabs/${created.body.data.id}/transition`).send({ action: "publish" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; slug: string };
}

describe("admin: members", () => {
  it("lists, searches, blocks, unblocks and deletes members (admin only)", async () => {
    const alice = await login("111111111111111111", "alice");
    const bob = await login("222222222222222222", "bobby");
    const collab = await publish("https://example.com/admin-members");
    await as(alice.token).put(`/v1/me/bookmarks/${collab.slug}`);
    await as(alice.token).put("/v1/me/follows/property/attack-on-titan");

    expect((await as(editor).get("/v1/admin/members")).status).toBe(403);
    expect((await as(alice.token).get("/v1/admin/members")).status).toBe(403);

    const list = await as(admin).get("/v1/admin/members");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data.map((m: { username: string }) => m.username)).toEqual(["bobby", "alice"]); // newest first
    expect(list.body.data[1]).toMatchObject({ bookmarkCount: 1, followCount: 1, active: true });

    expect((await as(admin).get("/v1/admin/members?q=ALI")).body.data.map((m: { id: string }) => m.id)).toEqual([alice.id]);
    expect((await as(admin).get("/v1/admin/members?q=222222222222222222")).body.data.map((m: { id: string }) => m.id)).toEqual([bob.id]);
    expect((await as(admin).get("/v1/admin/members?q=a.*")).body.data).toEqual([]); // not a regex

    const page = await as(admin).get("/v1/admin/members?limit=1");
    const next = await as(admin).get(`/v1/admin/members?limit=1&cursor=${page.body.meta.nextCursor}`);
    expect(next.body.data.map((m: { id: string }) => m.id)).toEqual([alice.id]);

    const blocked = await as(admin).patch(`/v1/admin/members/${bob.id}`).send({ active: false });
    expect(blocked.body.data.active).toBe(false);
    expect((await as(bob.token).get("/v1/me")).status).toBe(401);
    expect((await as(admin).get("/v1/admin/members?status=disabled")).body.data.map((m: { id: string }) => m.id)).toEqual([bob.id]);
    await as(admin).patch(`/v1/admin/members/${bob.id}`).send({ active: true });
    expect((await as(bob.token).get("/v1/me")).status).toBe(200);

    expect((await as(admin).delete(`/v1/admin/members/${alice.id}`)).status).toBe(204);
    expect(await Member.exists({ _id: alice.id })).toBeNull();
    expect((await as(admin).delete(`/v1/admin/members/${alice.id}`)).status).toBe(404);
    expect((await as(admin).patch("/v1/admin/members/not-an-id").send({ active: false })).status).toBe(422);
  });

  it("reports stats to editors without personal data", async () => {
    const carol = await login("333333333333333333", "carol");
    const collab = await publish("https://example.com/admin-stats");
    await as(carol.token).put(`/v1/me/bookmarks/${collab.slug}`);
    await as(carol.token).put("/v1/me/follows/company/krafton");

    const res = await as(editor).get("/v1/admin/members/stats");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.data;
    expect(s.members.total).toBeGreaterThanOrEqual(1);
    expect(s.members.new7d).toBe(s.members.total);
    expect(s.weekly).toHaveLength(12);
    expect(s.weekly.at(-1).signups).toBeGreaterThanOrEqual(1);
    expect(s.topSaved[0]).toMatchObject({ slug: collab.slug, count: 1 });
    expect(s.topFollowed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "company", slug: "krafton", count: 1 })]));
    expect(JSON.stringify(s)).not.toContain("carol");
  });

  it("adds saved and follower counts to the admin collab and entity responses", async () => {
    const dave = await login("444444444444444444", "dave");
    const collab = await publish("https://example.com/admin-counts");
    await as(dave.token).put(`/v1/me/bookmarks/${collab.slug}`);
    await as(dave.token).put("/v1/me/follows/property/pubg-mobile");

    expect((await as(editor).get(`/v1/admin/collabs/${collab.id}`)).body.data.bookmarkCount).toBe(1);
    const queue = await as(editor).get("/v1/admin/collabs?status=published");
    expect(queue.body.data.find((c: { id: string }) => c.id === collab.id).bookmarkCount).toBe(1);
    const props = await as(editor).get("/v1/admin/properties?locale=ko");
    expect(props.body.data.find((p: { slug: string }) => p.slug === "pubg-mobile").followerCount).toBeGreaterThanOrEqual(1);
    expect(props.body.data.find((p: { slug: string }) => p.slug === "jagariko").followerCount).toBe(0);
  });
});
