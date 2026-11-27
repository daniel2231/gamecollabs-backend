import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Collab } from "../src/models/collab.js";
import { Revision } from "../src/models/support.js";
import { ESCALATE } from "../src/lib/followUp.js";
import { refreshFollowUps } from "../src/services/followUps.js";
import { adminJwt, apiToken, as, draftBody, seedEntities, setupDb, teardownDb } from "./helpers.js";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * DAY));

let ingest: string;
let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;

beforeAll(async () => {
  await setupDb();
  ingest = await apiToken("mcp", "ingest");
  admin = await adminJwt("daniel");
  e = await seedEntities();
});
afterAll(teardownDb);

beforeEach(async () => {
  await Collab.deleteMany({});
});

async function draft(period: Record<string, unknown>, url = `https://example.com/${Math.random()}`, extra: Record<string, unknown> = {}) {
  const res = await as(admin).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id, { period, sources: [{ url, type: "official" }], ...extra }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; slug: string; rev: number; followUp: { reason: string | null; nextCheckAt: string | null } };
}

async function publish(id: string) {
  const res = await as(admin).post(`/v1/admin/collabs/${id}/transition`).send({ action: "publish" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; slug: string; rev: number };
}

const makeDue = (id: string) => Collab.updateOne({ _id: id }, { $set: { "followUp.nextCheckAt": new Date(Date.now() - 1000) } });
const due = async () => (await as(ingest).get("/v1/ingest/followups")).body.data as { slug: string; reason: string; rev: number }[];

describe("follow-up queue", () => {
  it("queues collabs missing dates on save, first check in 3 days", async () => {
    const tba = await draft({ endKind: "tba" });
    expect(tba.followUp.reason).toBe("start_tba");
    expect(new Date(tba.followUp.nextCheckAt!).getTime()).toBeGreaterThan(Date.now() + 2.9 * DAY);
    const complete = await draft({ start: inDays(-10), end: inDays(10) });
    expect(complete.followUp.reason).toBeNull();

    expect(await due()).toEqual([]);
    // The admin's full queue lists it before its turn comes; complete collabs stay out.
    const queued = await as(admin).get("/v1/admin/followups?view=queued");
    expect(queued.body.data.map((r: { slug: string }) => r.slug)).toEqual([tba.slug]);
    await makeDue(tba.id);
    const rows = await due();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: tba.slug, reason: "start_tba", status: "draft", period: { start: null, endKind: "tba" } });
  });

  it("pushes the next check back on no_change and escalates once", async () => {
    // No date to go by: only the backstop count escalates it.
    const c = await draft({ endKind: "tba" });
    for (let i = 1; i <= ESCALATE.maxChecks + 1; i++) {
      await makeDue(c.id);
      const res = await as(ingest).post(`/v1/ingest/followups/${c.slug}`).send({ outcome: "no_change" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ result: "recorded", escalated: i >= ESCALATE.maxChecks });
    }
    const stored = await Collab.findById(c.id).lean();
    expect(stored!.followUp.unchanged).toBe(ESCALATE.maxChecks + 1);
    expect(stored!.rev).toBe(c.rev); // bookkeeping never bumps rev
    expect(new Date(stored!.followUp.nextCheckAt!).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(await due()).toEqual([]);
    const escalated = await as(admin).get("/v1/admin/followups?view=escalated");
    expect(escalated.body.data.map((r: { slug: string }) => r.slug)).toEqual([c.slug]);
  });

  it("escalates a collab running without an end after 60 days and checks it weekly", async () => {
    const c = await publish((await draft({ start: inDays(-70), endKind: "tba" })).id);
    for (const escalated of [false, true]) {
      await makeDue(c.id);
      const res = await as(ingest).post(`/v1/ingest/followups/${c.slug}`).send({ outcome: "no_change" });
      expect(res.body.data).toMatchObject({ result: "recorded", escalated });
      const next = new Date(res.body.data.nextCheckAt).getTime();
      expect(next).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    }
    expect((await as(admin).get("/v1/admin/followups?view=escalated")).body.data.map((r: { slug: string }) => r.slug)).toEqual([c.slug]);
  });

  it("lists due collabs published first, then running, nearest start, expected window, undated", async () => {
    const year = new Date().getUTCFullYear() + 1;
    const undated = await draft({ endKind: "tba" });
    const expected = await draft({ endKind: "tba", expectedStart: `${year}-03` });
    const later = await draft({ start: inDays(40), endKind: "tba" });
    const soon = await draft({ start: inDays(10), endKind: "tba" });
    const running = await draft({ start: inDays(-3), endKind: "tba" });
    const published = await publish((await draft({ start: inDays(-5), endKind: "tba" })).id);
    for (const c of [undated, expected, later, soon, running, published]) await makeDue(c.id);
    expect((await due()).map((r) => r.slug)).toEqual([published, running, soon, later, expected, undated].map((c) => c.slug));
    const rows = await due();
    expect(rows.find((r) => r.slug === expected.slug)).toMatchObject({ reason: "start_tba", period: { start: null, expectedStart: `${year}-03` } });
  });

  it("stores a rough start window reported by a re-check", async () => {
    const year = new Date().getUTCFullYear() + 1;
    const c = await draft({ endKind: "tba" });
    const res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { period: { endKind: "tba", expectedStart: `${year}-09` } }, sources: [{ url: "https://example.com/window" }] });
    expect(res.body.data).toMatchObject({ result: "applied", reason: "start_tba" });
    const stored = await Collab.findById(c.id).lean();
    expect(stored!.period).toMatchObject({ start: null, expectedStart: new Date(Date.UTC(year, 8, 1)), expectedStartPrecision: "month" });
    // Not with a start.
    const bad = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev + 1, changes: { period: { start: inDays(5), endKind: "tba", expectedStart: `${year}-09` } }, sources: [{ url: "https://example.com/w2" }] });
    expect(bad.status).toBe(422);
  });

  it("applies updates to drafts with a revision and the new source", async () => {
    const c = await draft({ endKind: "tba" }, "https://example.com/teaser");
    const start = inDays(20);
    const res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { period: { start, end: inDays(50) } }, sources: [{ url: "https://example.com/dates", type: "official" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ result: "applied", rev: c.rev + 1, reason: null });

    const stored = await Collab.findById(c.id).lean();
    expect(iso(stored!.period.start!)).toBe(start);
    expect(stored!.sources.map((s) => s.url)).toEqual(["https://example.com/teaser", "https://example.com/dates"]);
    expect(stored!.sources[0]!.isPrimary).toBe(true);
    expect(stored!.followUp).toMatchObject({ reason: null, nextCheckAt: null, proposal: null });
    expect(await Revision.countDocuments({ collabId: c.id, action: "update" })).toBe(1);
  });

  it("keeps changes made to drafts listed until an admin acknowledges them", async () => {
    const c = await draft({ start: inDays(5), end: inDays(30) }, "https://example.com/teaser2", { contentTba: true });
    const i18n = {
      ko: { title: "배틀그라운드 모바일 × 진격의 거인", summary: "리바이 스킨이 추가된다." },
      en: { title: "PUBG Mobile x Attack on Titan", summary: "A Levi skin arrives." },
    };
    let res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { i18n }, sources: [{ url: "https://example.com/levi", type: "official" }] });
    expect(res.body.data).toMatchObject({ result: "applied", rev: c.rev + 1 });
    res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev + 1, changes: { contentTba: false }, sources: [{ url: "https://example.com/all", type: "official" }], note: "full list out" });
    expect(res.body.data).toMatchObject({ result: "applied", rev: c.rev + 2, reason: null });

    const listed = await as(admin).get("/v1/admin/followups?view=applied");
    expect(listed.body.data).toHaveLength(1);
    const applied = listed.body.data[0].applied;
    // The values from before the first change, and both changes folded together.
    expect(applied.before).toMatchObject({ contentTba: true, i18n: { en: { title: "PUBG Mobile x Attack on Titan" } } });
    expect(applied.before.i18n.en.summary).not.toBe(i18n.en.summary);
    expect(applied.changes).toMatchObject({ i18n, contentTba: false });
    expect(applied.sources.map((s: { url: string }) => s.url)).toEqual(["https://example.com/levi", "https://example.com/all"]);
    expect(applied).toMatchObject({ rev: c.rev + 2, by: "token:mcp", note: "full list out" });
    expect((await as(admin).get(`/v1/admin/collabs/${c.id}`)).body.data.followUp.applied).toMatchObject({ rev: c.rev + 2 });

    expect((await as(ingest).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "acknowledge" })).status).toBe(403);
    const ack = await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "acknowledge" });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect(ack.body.data).toMatchObject({ rev: c.rev + 2, followUp: { applied: null } });
    expect((await as(admin).get("/v1/admin/followups?view=applied")).body.data).toEqual([]);
    expect((await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "acknowledge" })).status).toBe(404);
  });

  it("keeps re-checking a draft that is still incomplete after an update", async () => {
    const c = await draft({ endKind: "tba" });
    const res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { period: { start: inDays(-5), endKind: "tba" } }, sources: [{ url: "https://example.com/start" }] });
    expect(res.body.data).toMatchObject({ result: "applied", reason: "end_tba" });
  });

  it("only proposes changes to published collabs, for an admin to apply or dismiss", async () => {
    const c = await publish((await draft({ start: inDays(-5), endKind: "tba" })).id);
    await makeDue(c.id);
    expect((await due()).map((r) => r.reason)).toEqual(["end_tba"]);

    const end = inDays(25);
    const report = { outcome: "updated", rev: c.rev, changes: { period: { start: inDays(-5), end } }, sources: [{ url: "https://example.com/end", type: "official" }], note: "end announced" };
    expect((await as(ingest).post(`/v1/ingest/followups/${c.id}`).send({ ...report, rev: c.rev - 1 })).status).toBe(412);
    const res = await as(ingest).post(`/v1/ingest/followups/${c.id}`).send(report);
    expect(res.body.data).toMatchObject({ result: "proposed" });

    let stored = await Collab.findById(c.id).lean();
    expect(stored!.period.end).toBeNull();
    expect(stored!.rev).toBe(c.rev);
    expect(await due()).toEqual([]);
    expect((await as(ingest).post(`/v1/ingest/followups/${c.id}`).send({ outcome: "no_change" })).status).toBe(409);

    const proposals = await as(admin).get("/v1/admin/followups?view=proposals");
    expect(proposals.body.data[0]).toMatchObject({ slug: c.slug, proposal: { note: "end announced", rev: c.rev, by: "token:mcp" } });

    // Agents and collectors cannot resolve proposals.
    expect((await as(ingest).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "apply" })).status).toBe(403);
    expect((await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "apply" })).status).toBe(428);
    const applied = await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).set("if-match", String(c.rev)).send({ action: "apply" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.data).toMatchObject({ rev: c.rev + 1, status: "published", followUp: { reason: null, proposal: null } });
    stored = await Collab.findById(c.id).lean();
    expect(iso(stored!.period.end!)).toBe(end);
    expect(stored!.sources).toHaveLength(2);
  });

  it("dismisses proposals and resumes checking", async () => {
    const c = await publish((await draft({ start: inDays(-5), endKind: "tba" })).id);
    await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { period: { start: inDays(-5), end: inDays(5) } }, sources: [{ url: "https://example.com/rumour" }] });
    const res = await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "dismiss" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rev: c.rev, followUp: { reason: "end_tba", proposal: null } });
    expect((await as(admin).post(`/v1/admin/collabs/${c.id}/followup`).send({ action: "dismiss" })).status).toBe(404);
  });

  it("clears contentTba when the content is announced", async () => {
    const c = await draft({ start: inDays(5), end: inDays(30) }, undefined, { contentTba: true });
    expect(c.followUp.reason).toBe("content_tba");
    await makeDue(c.id);
    expect(await due()).toMatchObject([{ slug: c.slug, reason: "content_tba", contentTba: true }]);

    const i18n = {
      ko: { title: "배틀그라운드 모바일 × 진격의 거인", summary: "리바이·미카사 스킨과 입체기동 장치가 추가된다." },
      en: { title: "PUBG Mobile x Attack on Titan", summary: "Levi and Mikasa skins and ODM gear arrive." },
    };
    const res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { i18n, contentTba: false }, sources: [{ url: "https://example.com/notes", type: "official" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ result: "applied", reason: null });
    const stored = await Collab.findById(c.id).lean();
    expect(stored!.contentTba).toBe(false);
    expect(stored!.i18n.en.summary).toBe(i18n.en.summary);
  });

  it("keeps the content flag while dates are re-checked first", async () => {
    const c = await draft({ endKind: "tba" }, undefined, { contentTba: true });
    const res = await as(ingest)
      .post(`/v1/ingest/followups/${c.id}`)
      .send({ outcome: "updated", rev: c.rev, changes: { period: { start: inDays(3), end: inDays(20) } }, sources: [{ url: "https://example.com/dates2" }] });
    expect(res.body.data).toMatchObject({ result: "applied", reason: "content_tba" });
  });

  it("validates reports", async () => {
    const c = await draft({ endKind: "tba" });
    const bad = [
      { outcome: "updated", rev: c.rev, changes: { period: { start: inDays(3) } } },
      { outcome: "updated", rev: c.rev, sources: [{ url: "https://example.com/x" }] },
      { outcome: "updated", changes: { period: { start: inDays(3) } }, sources: [{ url: "https://example.com/x" }] },
      { outcome: "maybe" },
    ];
    for (const body of bad) expect((await as(ingest).post(`/v1/ingest/followups/${c.id}`).send(body)).status, JSON.stringify(body)).toBe(422);
    expect((await as(ingest).post(`/v1/ingest/followups/nope`).send({ outcome: "no_change" })).status).toBe(404);
  });

  it("backfills and re-derives reasons in the daily job", async () => {
    const c = await draft({ endKind: "tba" });
    const ended = await draft({ start: inDays(-40), endKind: "tba" });
    await Collab.updateOne({ _id: ended.id }, { $set: { "period.end": new Date(Date.now() - 2 * DAY), "period.until": new Date(Date.now() - DAY), "period.endKind": "fixed" } });
    await Collab.updateMany({}, { $unset: { followUp: "" } });

    expect(await refreshFollowUps()).toMatchObject({ changed: 1, due: 1 });
    expect((await due()).map((r) => r.slug)).toEqual([c.slug]);
    expect(await refreshFollowUps()).toMatchObject({ changed: 0, pulled: 0, due: 1 });
    expect((await Collab.findById(c.id).lean())!.followUp.since).toBeTruthy();
    expect((await Collab.findById(ended.id).lean())!.followUp?.reason ?? null).toBeNull();
  });

  it("moves a check earlier in the daily job when the dates call for it, never later", async () => {
    const c = await draft({ start: inDays(10), end: inDays(12) }, undefined, { contentTba: true });
    // Scheduled by the old plain back-off: a month away, past the start.
    const late = new Date(Date.now() + 30 * DAY);
    await Collab.updateOne({ _id: c.id }, { $set: { "followUp.nextCheckAt": late, "followUp.lastCheckedAt": new Date(), "followUp.unchanged": 3 } });
    expect(await refreshFollowUps()).toMatchObject({ changed: 0, pulled: 1 });
    const next = (await Collab.findById(c.id).lean())!.followUp.nextCheckAt!.getTime();
    // 7 days before the start.
    expect(next).toBeGreaterThan(Date.now() + 2.5 * DAY);
    expect(next).toBeLessThan(Date.now() + 3.5 * DAY);
    expect(await refreshFollowUps()).toMatchObject({ pulled: 0 });
  });
});
