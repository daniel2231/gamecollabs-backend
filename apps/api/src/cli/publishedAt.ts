import { Collab } from "../models/collab.js";
import { Revision } from "../models/support.js";
import { revalidate } from "../lib/outbound.js";

/**
 * Finds collabs whose first publication date lies in the future (older migrations copied the start
 * date into it, so a collab announced for next year sat atop the feed until then). `apply` moves each
 * one to when it was created (or now, if that is later than now) and records a revision.
 */
export async function fixPublishedAt(opts: { apply: boolean }, now = new Date()) {
  const docs = await Collab.find({ "review.publishedAt": { $gt: now } })
    .select({ slug: 1, status: 1, rev: 1, createdAt: 1, "review.publishedAt": 1 })
    .sort({ "review.publishedAt": -1 })
    .lean();
  const rows = docs.map((d) => {
    const created = d.createdAt ? new Date(d.createdAt) : null;
    const to = created && created < now ? created : now;
    return { id: d._id, slug: d.slug, status: d.status, rev: d.rev, from: d.review!.publishedAt!.toISOString(), to: to.toISOString() };
  });
  if (!opts.apply) return { applied: false, count: rows.length, rows: rows.map(({ id, rev, ...r }) => r) };

  for (const r of rows) {
    // Not an editorial change: keep rev and updatedAt so open editors and caches stay valid.
    await Collab.updateOne({ _id: r.id }, { $set: { "review.publishedAt": new Date(r.to) } }, { timestamps: false });
    await Revision.create({ collabId: r.id, rev: r.rev, actorLabel: "cli:fix-published-at", action: "update", diff: { "review.publishedAt": { from: r.from, to: r.to } } });
  }
  if (rows.some((r) => r.status === "published")) revalidate(["collabs"]);
  return { applied: true, count: rows.length, fixed: rows.map((r) => r.slug) };
}
