import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { setConfig } from "../src/config.js";
import { Collab } from "../src/models/collab.js";
import { Property } from "../src/models/entities.js";
import { IngestRun, JobLock, Submission } from "../src/models/support.js";
import { migrateMdx } from "../src/cli/migrate.js";
import { consistency, recount, reindexFacets } from "../src/jobs/tasks.js";
import { withJobLock } from "../src/jobs/lock.js";
import { SERVICE_TOKEN, adminJwt, apiToken, as, seedEntities, setupDb, teardownDb } from "./helpers.js";
import type { Config } from "../src/config.js";

let cfg: Config;
let ingest: string;
let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;

beforeAll(async () => {
  cfg = await setupDb();
  ingest = await apiToken("mcp", "ingest");
  admin = await adminJwt("daniel");
  e = await seedEntities();
});
afterAll(teardownDb);

const candidate = (over: Record<string, unknown> = {}) => ({
  title: { ko: "배틀그라운드 모바일 × 진격의 거인", en: "PUBG Mobile x Attack on Titan" },
  summary: { ko: "콜라보 스킨이 추가된다.", en: "Collab skins are added." },
  game: { name: "PUBG M" },
  partner: { name: "Shingeki no Kyojin", kind: "Anime / Manga" },
  companies: [{ name: "Krafton", role: "publisher" }, { name: "Unknown Co", role: "licensor" }],
  category: "In-Game",
  regions: ["South Korea", "Atlantis"],
  platforms: ["Android"],
  collabTypes: ["Skin"],
  period: { start: "2026-11-01", end: "2026-11-30" },
  sources: [{ url: "https://news.example.com/pubg-aot", type: "press" }],
  confidence: 0.8,
  ...over,
});

describe("ingest", () => {
  beforeEach(async () => {
    await Collab.deleteMany({});
    await IngestRun.deleteMany({});
  });

  it("creates drafts, maps values, keeps what it cannot map", async () => {
    const res = await as(ingest).post("/v1/ingest/candidates").send({ client: "chatgpt-mcp", runId: "run-1", candidates: [candidate()] });
    expect(res.status).toBe(200);
    const [r] = res.body.data.results;
    expect(r.status).toBe("created");
    expect(r.unmapped).toEqual({ region: ["Atlantis"], companies: ["Unknown Co (licensor)"] });
    const doc = await Collab.findById(r.id).lean();
    expect(doc).toMatchObject({
      status: "draft",
      category: "category.in_game",
      regions: ["region.korea"],
      platforms: ["platform.android"],
      collabTypes: ["collab_type.cosmetic_item"],
      origin: { type: "gpt", runId: "run-1", client: "chatgpt-mcp", confidence: 0.8 },
    });
    expect(doc!.parties.map((p) => p.slug)).toEqual(["pubg-mobile", "attack-on-titan"]);
    expect(doc!.companies).toHaveLength(1);
    const run = await IngestRun.findOne({ runId: "run-1" }).lean();
    expect(run!.counts).toEqual({ created: 1, duplicate: 0, rejected: 0 });
  });

  it("is idempotent on source URL and detects same parties ±14 days", async () => {
    await as(ingest).post("/v1/ingest/candidates").send({ client: "chatgpt-mcp", candidates: [candidate()] });
    const res = await as(ingest)
      .post("/v1/ingest/candidates")
      .send({
        client: "chatgpt-mcp",
        candidates: [
          candidate({ sources: [{ url: "https://news.example.com/pubg-aot?utm_campaign=y" }] }),
          candidate({ sources: [{ url: "https://other.example.com/x" }], period: { start: "2026-11-10" } }),
          candidate({ sources: [{ url: "https://other.example.com/y" }], period: { start: "2027-03-01" } }),
        ],
      });
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(["duplicate", "duplicate", "created"]);
    expect(res.body.data.results[0].reasons[0].code).toBe("same_source_url");
    expect(res.body.data.results[1].reasons[0].code).toBe("same_parties_and_date");
  });

  it("rejects invalid candidates individually", async () => {
    const res = await as(ingest)
      .post("/v1/ingest/candidates")
      .send({ client: "chatgpt-mcp", candidates: [{ title: {} }, candidate({ sources: [{ url: "https://a.example.com/ok" }] })] });
    expect(res.body.data.summary).toEqual({ created: 1, duplicate: 0, rejected: 1 });
    expect(res.body.data.results[0].reasons[0].code).toBe("invalid");
  });

  it("accepts candidates without an announced start date as drafts and dedupes them", async () => {
    const undated = (url: string) => candidate({ period: undefined, sources: [{ url }] });
    const first = await as(ingest).post("/v1/ingest/candidates").send({ client: "chatgpt-mcp", candidates: [undated("https://news.example.com/undated-1")] });
    const [r] = first.body.data.results;
    expect(r.status).toBe("created");
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/start date not announced/)]));
    const doc = await Collab.findById(r.id).lean();
    expect(doc).toMatchObject({ status: "draft", period: { start: null, endKind: "tba" } });

    // Same game and partner, still undated, reported by another article: not a second draft.
    const again = await as(ingest).post("/v1/ingest/candidates").send({ client: "chatgpt-mcp", candidates: [undated("https://other.example.com/undated-2")] });
    expect(again.body.data.results[0]).toMatchObject({ status: "duplicate", reasons: [{ code: "same_parties_and_date" }] });
  });

  it("rejects candidates missing either language", async () => {
    const res = await as(ingest)
      .post("/v1/ingest/candidates")
      .send({ candidates: [candidate({ title: { ko: "제목만" } }), candidate({ summary: { en: "English only" } })] });
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(["rejected", "rejected"]);
    expect(res.body.data.results[0].reasons[0].message).toMatch(/title\.en/);
    expect(res.body.data.results[1].reasons[0].message).toMatch(/summary\.ko/);
  });

  it("caps candidates per call and per day", async () => {
    const many = Array.from({ length: 21 }, () => candidate());
    expect((await as(ingest).post("/v1/ingest/candidates").send({ candidates: many })).status).toBe(422);

    setConfig({ ...cfg, INGEST_DAILY_LIMIT: 2 });
    try {
      const res = await as(ingest)
        .post("/v1/ingest/candidates")
        .send({
          client: "agent",
          candidates: [1, 2, 3].map((i) => candidate({ sources: [{ url: `https://x.example.com/${i}` }], period: { start: `2027-0${i}-01` } })),
        });
      expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(["created", "created", "rejected"]);
      expect(res.body.data.results[2].reasons[0].code).toBe("daily_limit");
    } finally {
      setConfig(cfg);
    }
  });

  it("verifies source URLs when enabled (and never fetches private hosts)", async () => {
    setConfig({ ...cfg, INGEST_VERIFY_SOURCES: true });
    try {
      const res = await as(ingest)
        .post("/v1/ingest/candidates")
        .send({ candidates: [candidate({ sources: [{ url: "http://127.0.0.1:9/private" }] })] });
      expect(res.body.data.results[0]).toMatchObject({ status: "rejected", reasons: [{ code: "source_unreachable" }] });
    } finally {
      setConfig(cfg);
    }
  });

  it("is limited to ingest tokens and known channels", async () => {
    expect((await as(SERVICE_TOKEN).post("/v1/ingest/candidates").send({ candidates: [candidate()] })).status).toBe(403);
    expect((await as(ingest).post("/v1/ingest/news").send({ candidates: [candidate()] })).status).toBe(404);
    expect((await as(ingest).post("/v1/admin/collabs").send({})).status).toBe(403);
  });

  it("offers minimal lookups to collectors", async () => {
    await as(ingest).post("/v1/ingest/candidates").send({ candidates: [candidate()] });
    const entities = await as(ingest).get("/v1/ingest/lookup/entities?name=AoT");
    expect(entities.body.data[0]).toMatchObject({ type: "property", slug: "attack-on-titan", exact: true });
    const collabs = await as(ingest).get(`/v1/ingest/lookup/collabs?q=${encodeURIComponent("진격의 거인")}`);
    expect(collabs.body.data[0]).toMatchObject({ status: "draft", sourceUrls: ["https://news.example.com/pubg-aot"] });
    expect(collabs.body.data[0].review).toBeUndefined();
  });
});

describe("submissions and read-only mode", () => {
  it("queues submissions with honeypot and rate limit", async () => {
    const res = await as(SERVICE_TOKEN).post("/v1/submissions").set("x-client-ip", "203.0.113.5").send({ url: "https://example.com/tip", note: "new collab" });
    expect(res.status).toBe(202);
    expect(await Submission.countDocuments()).toBe(1);
    expect((await as(SERVICE_TOKEN).post("/v1/submissions").send({ url: "https://example.com/tip2", website: "spam" })).status).toBe(422);
    const list = await as(admin).get("/v1/admin/submissions");
    expect(list.body.data[0].url).toBe("https://example.com/tip");
  });

  it("blocks writes in read-only mode", async () => {
    setConfig({ ...cfg, READ_ONLY_MODE: true });
    try {
      const res = await as(admin).post("/v1/admin/properties").send({ slug: "x", kind: "partner_category.game", name: { ko: "엑스", en: "X" } });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("read_only");
      expect((await as(admin).get("/v1/collabs")).status).toBe(200);
    } finally {
      setConfig(cfg);
    }
  });
});

describe("jobs", () => {
  it("never runs the same job twice at once", async () => {
    let release!: () => void;
    const first = withJobLock("test-job", 60_000, () => new Promise<string>((r) => (release = () => r("done"))));
    await new Promise((r) => setTimeout(r, 50));
    expect(await withJobLock("test-job", 60_000, async () => "second")).toBe("locked");
    release();
    expect(await first).toBe("done");
    expect((await JobLock.findById("test-job").lean())!.lockedUntil).toBeNull();
  });

  it("repairs counts, snapshots and facets", async () => {
    await Property.updateMany({}, { collabCount: 99 });
    await Collab.updateMany({}, { $set: { "parties.$[].name": { ko: "stale", en: "stale" }, facetKeys: [] } });
    expect((await recount()).properties).toBeGreaterThanOrEqual(0);
    expect((await Property.findById(e.pubg.id))!.collabCount).toBe(0);
    expect((await consistency()).fixed).toBeGreaterThan(0);
    expect((await Collab.findOne({}).lean())!.parties[0]!.name!.ko).not.toBe("stale");
    expect((await reindexFacets()).updated).toBeGreaterThan(0);
  });
});

describe("MDX migration", () => {
  const dir = fileURLToPath(new URL("./fixtures/mdx", import.meta.url));

  beforeAll(async () => {
    await Collab.deleteMany({});
  });

  it("dry-run reports values it cannot map", async () => {
    const report = await migrateMdx({ dir, dryRun: true, allowUnmapped: false });
    expect(report.files).toBe(3);
    expect(report.unmapped).toEqual({ "platform: Offline Retail": 1 });
    expect(await Collab.countDocuments()).toBe(0);
    const aborted = await migrateMdx({ dir, dryRun: false, allowUnmapped: false });
    expect(aborted.aborted).toBe(true);
  });

  it("refuses files missing a Korean or English text", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = await mkdtemp(join(tmpdir(), "mdx-"));
    await writeFile(
      join(tmp, "one-language.mdx"),
      "---\ngame_title: Game\nip_title: IP\nip_title_ko: 아이피\nsummary_ko: 요약\nstart_date: 2026-01-01\nsource_url: https://example.com/x\n---\n",
    );
    const report = await migrateMdx({ dir: tmp, dryRun: true, allowUnmapped: true });
    expect(report.problems).toEqual(["one-language.mdx: missing game_title_ko", "one-language.mdx: missing summary_en"]);
  });

  it("imports unpublishable items as drafts and accepts several keys per mapped value", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = await mkdtemp(join(tmpdir(), "mdx-"));
    const file = (extra: string) =>
      "---\ntitle: 게임 × 아이피\ntitle_en: Game x IP\ngame_title: Game\ngame_title_ko: 게임\nip_title: IP\nip_title_ko: 아이피\n" +
      "summary_ko: 요약\nsummary_en: Summary\ncategory: In-Game\nplatform: [PC / Console]\npartner_category: [Comics, Film / TV]\n" +
      `source_url: https://example.com/${extra}\n${extra === "dated" ? "start_date: 2026-01-01\n" : ""}---\n`;
    await writeFile(join(tmp, "dated.mdx"), file("dated"));
    await writeFile(join(tmp, "undated.mdx"), file("undated"));
    const opts = { dir: tmp, dryRun: false, allowUnmapped: false, mapping: { platform: { "PC / Console": ["platform.pc", "platform.console"] } } };
    const dry = await migrateMdx({ ...opts, dryRun: true });
    expect(dry.unmapped).toEqual({});
    expect(dry.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/undated\.mdx: will be imported as draft \(missing start_date\)/), expect.stringMatching(/several partner_category/)]),
    );
    await migrateMdx(opts);
    const dated = await Collab.findOne({ slug: "dated" }).lean();
    expect(dated).toMatchObject({ status: "published", platforms: ["platform.pc", "platform.console"] });
    expect((await Collab.findOne({ slug: "undated" }).lean())!.status).toBe("draft");
    const bad = await migrateMdx({ ...opts, dryRun: true, mapping: { platform: { "PC / Console": ["platform.n64"] } } });
    expect(Object.keys(bad.unmapped)[0]).toMatch(/key not in taxonomy/);
    await Collab.deleteMany({ slug: { $in: ["dated", "undated"] } });
  });

  it("resolves blog-relative image paths and keeps mirrored covers on re-runs", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = await mkdtemp(join(tmpdir(), "mdx-"));
    await writeFile(
      join(tmp, "relative-image.mdx"),
      "---\ntitle: 게임 × 아이피\ntitle_en: Game x IP\ngame_title: Game\ngame_title_ko: 게임\nip_title: IP\nip_title_ko: 아이피\n" +
        "summary_ko: 요약\nsummary_en: Summary\ncategory: In-Game\nstart_date: 2026-01-01\nimage: /blog/uploads/key art.jpg\n" +
        "source_url: https://example.com/relative-image\n---\n",
    );
    const opts = { dir: tmp, dryRun: false, allowUnmapped: false };
    const withoutBase = await migrateMdx({ ...opts, dryRun: true });
    expect(withoutBase.problems[0]).toMatch(/relative-image\.mdx: image "\/blog\/uploads\/key art\.jpg" is a path on the old blog/);

    await migrateMdx({ ...opts, imageBaseUrl: "https://blog.example.com" });
    const doc = await Collab.findOne({ slug: "relative-image" }).lean();
    expect(doc!.cover!.originalUrl).toBe("https://blog.example.com/blog/uploads/key%20art.jpg");

    await Collab.updateOne({ slug: "relative-image" }, { $set: { "cover.storageKey": "collabs/relative-image/cover.jpg" } });
    await migrateMdx({ ...opts, imageBaseUrl: "https://blog.example.com" });
    expect((await Collab.findOne({ slug: "relative-image" }).lean())!.cover!.storageKey).toBe("collabs/relative-image/cover.jpg");
    await Collab.deleteMany({ slug: "relative-image" });
  });

  it("migrates with an explicit mapping, re-runnable, with a clean reconciliation", async () => {
    const opts = { dir, dryRun: false, allowUnmapped: false, mapping: { platform: { "Offline Retail": null } }, entityMap: { AoT: "Attack on Titan" } };
    const first = await migrateMdx(opts);
    expect(first.reconciliation).toMatchObject({ expected: 3, stored: 3, missing: [], periodMismatch: [], classificationMismatch: [] });
    const second = await migrateMdx(opts);
    expect(second.written).toBe(3);
    expect(await Collab.countDocuments({ "origin.type": "migration" })).toBe(3);

    const taiko = await Collab.findOne({ slug: "taiko-no-tatsujin-jagariko-2026-10" }).lean();
    expect(taiko).toMatchObject({
      status: "published",
      category: "category.brand_campaign",
      collabTypes: ["collab_type.music", "collab_type.in_game_reward", "collab_type.cosmetic_item"],
      sources: [{ url: "https://www.calbee.co.jp/taiko", isPrimary: true }],
    });
    expect(taiko!.companies.map((c) => c.role)).toEqual(["unspecified", "unspecified"]);
    expect(taiko!.companies[1]!.name).toEqual({ ko: "가루비", en: "Calbee" });
    expect(taiko!.i18n.en.title).toBe("Taiko no Tatsujin x Jagariko");
    expect(taiko!.origin.notes).toBe("공식 특설 페이지 기준.\ntags: snack, arcade");
    const blood = await Collab.findOne({ slug: "blood-strike-aot-2026-08" }).lean();
    expect(blood!.i18n.ko.title).toBe("블러드 스트라이크 × 진격의 거인");
    expect(blood!.i18n.en.title).toBe("Blood Strike x Attack on Titan");
    expect(blood!.platforms).toEqual(["platform.mobile", "platform.ps5"]);
    expect(blood!.parties[1]!.slug).toBe("attack-on-titan");
    const pubg = await Collab.findOne({ slug: "pubg-mobile-attack-on-titan-2026-09" }).lean();
    expect(pubg!.period).toMatchObject({ endKind: "tba", end: null });
    // Existing entities were reused, not duplicated.
    expect(await Property.countDocuments({ slug: /attack-on-titan/ })).toBe(1);
    expect((await Property.findOne({ slug: "attack-on-titan" }))!.collabCount).toBe(2);
  });
});
