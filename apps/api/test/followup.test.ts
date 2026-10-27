import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Collab } from "../src/models/collab.js";
import { Revision } from "../src/models/support.js";
import { ESCALATE_AFTER, followUpReasonOf, nextCheckAt } from "../src/lib/followUp.js";
import { toStoredPeriod } from "../src/lib/period.js";
import { refreshFollowUps } from "../src/services/followUps.js";
import { adminJwt, apiToken, as, draftBody, seedEntities, setupDb, teardownDb } from "./helpers.js";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => iso(new Date(Date.now() + n * DAY));

describe("follow-up reasons", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const reason = (period: Parameters<typeof toStoredPeriod>[0], status = "published", contentTba = false) =>
    followUpReasonOf({ status, period: toStoredPeriod(period), contentTba }, now);

  it("derives what is still missing from the period", () => {
    expect(reason({ endKind: "tba" }, "draft")).toBe("start_tba");
    expect(reason({ start: "2026-11", endKind: "tba" })).toBe("month_only");
    expect(reason({ start: "2026-10", endKind: "tba" })).toBe("month_only");
    // Once the start month is over, the end is what matters.
    expect(reason({ start: "2026-09", endKind: "tba" })).toBe("end_tba");
    expect(reason({ start: "2026-10-01", endKind: "tba" })).toBe("end_tba");
    expect(reason({ start: "2026-10-01" })).toBe("end_missing");
  });

  it("stops for complete, permanent, ended and archived collabs", () => {
    expect(reason({ start: "2026-10-01", end: "2026-10-31" })).toBeNull();
    expect(reason({ start: "2026-10-01", endKind: "permanent" })).toBeNull();
    expect(reason({ start: "2026-08-01", end: "2026-09-30" })).toBeNull();
    expect(reason({ endKind: "tba" }, "archived")).toBeNull();
  });

  it("re-checks the content once the dates are known", () => {
    expect(reason({ start: "2026-10-01", end: "2026-10-31" }, "published", true)).toBe("content_tba");
    expect(reason({ start: "2026-10-01", endKind: "permanent" }, "published", true)).toBe("content_tba");
    // Missing dates come first; ended and archived collabs are not re-checked.
    expect(reason({ endKind: "tba" }, "draft", true)).toBe("start_tba");
    expect(reason({ start: "2026-10-01", endKind: "tba" }, "published", true)).toBe("end_tba");
    expect(reason({ start: "2026-08-01", end: "2026-09-30" }, "published", true)).toBeNull();
    expect(reason({ start: "2026-10-01", end: "2026-10-31" }, "archived", true)).toBeNull();
  });

  it("backs off 3 → 7 → 14 → 30 days", () => {
    expect([0, 1, 2, 3, 9].map((n) => (nextCheckAt(n, now).getTime() - now.getTime()) / DAY)).toEqual([3, 7, 14, 30, 30]);
  });
});

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
    const c = await draft({ endKind: "tba" });
    for (let i = 1; i <= ESCALATE_AFTER + 1; i++) {
      await makeDue(c.id);
      const res = await as(ingest).post(`/v1/ingest/followups/${c.slug}`).send({ outcome: "no_change" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({ result: "recorded", escalated: i >= ESCALATE_AFTER });
    }
    const stored = await Collab.findById(c.id).lean();
    expect(stored!.followUp.unchanged).toBe(ESCALATE_AFTER + 1);
    expect(stored!.rev).toBe(c.rev); // bookkeeping never bumps rev
    expect(new Date(stored!.followUp.nextCheckAt!).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(await due()).toEqual([]);
    const escalated = await as(admin).get("/v1/admin/followups?view=escalated");
    expect(escalated.body.data.map((r: { slug: string }) => r.slug)).toEqual([c.slug]);
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
    expect(await refreshFollowUps()).toMatchObject({ changed: 0, due: 1 });
  });
});
