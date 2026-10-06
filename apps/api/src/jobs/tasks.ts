import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import mongoose from "mongoose";
import { config } from "../config.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { notify, revalidate } from "../lib/outbound.js";
import { checkUrl, isReachable } from "../lib/safeFetch.js";
import { mirrorCover } from "../services/media.js";
import { snapshotName } from "../services/collabs.js";
import { taxonomy } from "../services/taxonomy.js";

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** F-10: weekly source URL check; broken links are reported to the operator. */
export async function linkCheck() {
  const collabs = await Collab.find({ status: "published" }).select({ slug: 1, sources: 1 }).lean();
  const targets = collabs.flatMap((c) => c.sources.map((s) => ({ id: c._id, slug: c.slug, url: s.url })));
  const broken: { slug: string; url: string; status: number | string | null }[] = [];
  await pool(targets, 5, async (t) => {
    const result = await checkUrl(t.url);
    await Collab.updateOne(
      { _id: t.id },
      { $set: { "sources.$[s].lastCheckedAt": new Date(), "sources.$[s].httpStatus": result.status } },
      { arrayFilters: [{ "s.url": t.url }], timestamps: false },
    );
    if (!isReachable(result.status)) broken.push({ slug: t.slug, url: t.url, status: result.status ?? result.error ?? null });
  });
  if (broken.length) notify(`Link check: ${broken.length} broken source link(s)`, { broken: broken.slice(0, 30) });
  return { checked: targets.length, broken: broken.length };
}

/** Recomputes `collabCount` for every property and company from published collabs. */
export async function recount() {
  const [props, companies] = await Promise.all([
    Collab.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { status: "published" } },
      { $unwind: "$parties" },
      { $match: { "parties.propertyId": { $ne: null } } },
      { $group: { _id: { c: "$_id", p: "$parties.propertyId" } } },
      { $group: { _id: "$_id.p", n: { $sum: 1 } } },
    ]),
    Collab.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { status: "published" } },
      { $unwind: "$companies" },
      { $group: { _id: { c: "$_id", co: "$companies.companyId" } } },
      { $group: { _id: "$_id.co", n: { $sum: 1 } } },
    ]),
  ]);
  await Property.updateMany({}, { collabCount: 0 });
  await Company.updateMany({}, { collabCount: 0 });
  if (props.length) await Property.bulkWrite(props.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { collabCount: p.n } } })));
  if (companies.length) await Company.bulkWrite(companies.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { collabCount: c.n } } })));
  return { properties: props.length, companies: companies.length };
}

/** Weekly: fixes name/slug snapshots that drifted from their entity. */
export async function consistency() {
  let fixed = 0;
  const tags = new Set<string>();
  for (const [Model, path, field] of [
    [Property, "parties", "propertyId"],
    [Company, "companies", "companyId"],
  ] as const) {
    for await (const e of (Model as typeof Property).find().lean().cursor()) {
      const snap = snapshotName(e.name);
      const filter = {
        [path]: {
          $elemMatch: { [field]: e._id, $or: [{ "name.ko": { $ne: snap.ko } }, { "name.en": { $ne: snap.en } }, { slug: { $ne: e.slug } }] },
        },
      };
      const stale = await Collab.find(filter).select({ slug: 1, status: 1 }).lean();
      if (!stale.length) continue;
      const res = await Collab.updateMany(
        { _id: { $in: stale.map((s) => s._id) } },
        { $set: { [`${path}.$[e].name`]: snap, [`${path}.$[e].slug`]: e.slug } },
        { arrayFilters: [{ [`e.${field}`]: e._id }], timestamps: false },
      );
      fixed += res.modifiedCount;
      stale.filter((s) => s.status === "published").forEach((s) => tags.add(`collab:${s.slug}`));
    }
  }
  if (tags.size) revalidate(["collabs", ...tags]);
  if (fixed) notify(`Consistency check fixed ${fixed} stale name snapshot(s)`);
  return { fixed };
}

/** Recomputes `facetKeys` after taxonomy hierarchy changes. */
export async function reindexFacets() {
  const tax = await taxonomy();
  let updated = 0;
  for await (const c of Collab.find().select({ category: 1, regions: 1, platforms: 1, collabTypes: 1, parties: 1, facetKeys: 1 }).lean().cursor()) {
    const keys = tax.expand([
      ...(c.category ? [c.category] : []),
      ...c.regions,
      ...c.platforms,
      ...c.collabTypes,
      ...c.parties.filter((p) => p.role === "partner" && p.kind).map((p) => p.kind!),
    ]);
    if (JSON.stringify(keys) !== JSON.stringify(c.facetKeys)) {
      await Collab.updateOne({ _id: c._id }, { $set: { facetKeys: keys } }, { timestamps: false });
      updated++;
    }
  }
  if (updated) revalidate(["collabs"]);
  return { updated };
}

/** F-09: copies cover images that are still hot-linked into object storage. */
export async function mirrorCovers(limit = 50) {
  const docs = await Collab.find({ "cover.originalUrl": { $ne: null }, "cover.storageKey": null, "cover.mirrorError": null }).limit(limit);
  const counts = { mirrored: 0, skipped: 0, failed: 0 };
  for (const doc of docs) counts[await mirrorCover(doc)]++;
  return counts;
}

/** Portable JSON dump (MongoDB Extended JSON), one file per collection, for the weekly Git export. */
export async function exportJson(dir = config().EXPORT_DIR) {
  await mkdir(dir, { recursive: true });
  const { EJSON } = mongoose.mongo.BSON;
  const out: Record<string, number> = {};
  for (const name of ["collabs", "properties", "companies", "taxonomy_terms"]) {
    const docs = await mongoose.connection.db!.collection(name).find({}, { projection: { searchTokens: 0, nameKeys: 0 } }).sort({ _id: 1 }).toArray();
    await writeFile(join(dir, `${name}.json`), EJSON.stringify(docs, undefined, 2, { relaxed: true }) + "\n");
    out[name] = docs.length;
  }
  return out;
}
