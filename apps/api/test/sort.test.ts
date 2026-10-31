import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { CollabListQuery } from "@gamecollabs/schema";
import { fixPublishedAt } from "../src/cli/publishedAt.js";
import { Collab } from "../src/models/collab.js";
import { Revision } from "../src/models/support.js";
import { phaseOf, toStoredPeriod } from "../src/lib/period.js";
import { listPublic } from "../src/services/collabs.js";
import { setupDb, teardownDb } from "./helpers.js";

const NOW = new Date("2026-10-31T03:00:00Z");

/** slug → period; written straight to the collection, only the fields the list query reads. */
const PERIODS: Record<string, Parameters<typeof toStoredPeriod>[0]> = {
  "ongoing-old": { start: "2026-09-01", end: "2026-11-30" },
  "ongoing-new": { start: "2026-10-20", end: "2026-11-15" },
  "ongoing-permanent": { start: "2026-10-01", endKind: "permanent" },
  "upcoming-next-week": { start: "2026-11-07", end: "2026-11-30" },
  "upcoming-next-year": { start: "2027-01-15", endKind: "tba" },
  "upcoming-month": { start: "2026-12", precision: "month" },
  "ended-long-ago": { start: "2026-01-01", end: "2026-02-01" },
  "ended-yesterday": { start: "2026-10-01", end: "2026-10-30" },
  "unknown-started": { start: "2026-08-01", endKind: "fixed" },
  "unknown-no-date": {},
};

beforeAll(async () => {
  await setupDb();
  await Collab.collection.insertMany(
    Object.entries(PERIODS).map(([slug, p]) => ({ _id: new Types.ObjectId(), slug, status: "published", facetKeys: [], period: toStoredPeriod(p) })),
  );
});
afterAll(teardownDb);

async function pageThrough(limit: number) {
  const slugs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listPublic(CollabListQuery.parse({ sort: "current", limit, cursor }), NOW);
    expect(page.total).toBe(Object.keys(PERIODS).length);
    slugs.push(...page.items.map((c) => c.slug));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return slugs;
}

describe("current sort", () => {
  it("is the default", () => {
    expect(CollabListQuery.parse({}).sort).toBe("current");
  });

  it("lists ongoing (newest start), upcoming (soonest), ended (latest end), then unknown", async () => {
    const expected = [
      "ongoing-new",
      "ongoing-permanent",
      "ongoing-old",
      "upcoming-next-week",
      "upcoming-month",
      "upcoming-next-year",
      "ended-yesterday",
      "ended-long-ago",
      "unknown-started",
      "unknown-no-date",
    ];
    expect(await pageThrough(100)).toEqual(expected);
    // Keyset pages line up with the single page, whatever the page size.
    expect(await pageThrough(1)).toEqual(expected);
    expect(await pageThrough(3)).toEqual(expected);
  });

  it("ranks each collab by the same phase the cards show", async () => {
    const { items } = await listPublic(CollabListQuery.parse({ sort: "current", limit: 100 }), NOW);
    for (const c of items) expect(c.slug.startsWith(phaseOf({ start: c.period?.start ?? null, until: c.period?.until ?? null, endKind: c.period?.endKind ?? "fixed" }, NOW)), c.slug).toBe(true);
  });

  it("keeps phase filters and rejects foreign cursors", async () => {
    const upcoming = await listPublic(CollabListQuery.parse({ sort: "current", phase: "upcoming", limit: 100 }), NOW);
    expect(upcoming.items.map((c) => c.slug)).toEqual(["upcoming-next-week", "upcoming-month", "upcoming-next-year"]);
    const dated = await listPublic(CollabListQuery.parse({ sort: "start_desc", limit: 1 }), NOW);
    await expect(listPublic(CollabListQuery.parse({ sort: "current", limit: 1, cursor: dated.nextCursor! }), NOW)).rejects.toMatchObject({ status: 400 });
  });
});

describe("fix-published-at", () => {
  it("moves future publication dates to when the collab was created", async () => {
    const created = new Date("2026-10-01T00:00:00Z");
    await Collab.collection.updateOne({ slug: "upcoming-next-year" }, { $set: { rev: 3, createdAt: created, "review.publishedAt": new Date("2027-01-15T00:00:00Z") } });
    await Collab.collection.updateOne({ slug: "ongoing-new" }, { $set: { "review.publishedAt": new Date("2026-10-20T00:00:00Z") } });

    const dry = await fixPublishedAt({ apply: false }, NOW);
    expect(dry).toMatchObject({ applied: false, count: 1, rows: [{ slug: "upcoming-next-year", to: created.toISOString() }] });
    expect((await Collab.findOne({ slug: "upcoming-next-year" }).lean())!.review!.publishedAt!.toISOString()).toBe("2027-01-15T00:00:00.000Z");

    expect(await fixPublishedAt({ apply: true }, NOW)).toEqual({ applied: true, count: 1, fixed: ["upcoming-next-year"] });
    const doc = (await Collab.findOne({ slug: "upcoming-next-year" }).lean())!;
    expect(doc.review!.publishedAt!.toISOString()).toBe(created.toISOString());
    expect(doc.rev).toBe(3);
    expect(await Revision.countDocuments({ collabId: doc._id, actorLabel: "cli:fix-published-at" })).toBe(1);
    // The feed now leads with what was actually published last.
    const feed = await listPublic(CollabListQuery.parse({ sort: "recent", limit: 1 }), NOW);
    expect(feed.items[0]!.slug).toBe("ongoing-new");
    expect((await fixPublishedAt({ apply: false }, NOW)).count).toBe(0);
  });
});
