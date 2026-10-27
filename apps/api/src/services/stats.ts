import { COMPANY_ROLES, PHASES, type Locale } from "@gamecollabs/schema";
import { phaseFilter } from "../lib/period.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { pick } from "./serialize.js";
import type { TaxonomyIndex } from "./taxonomy.js";

type Bucket = { _id: string | null; count: number };
type Name = { ko?: string | null; en?: string | null };
type Ranked = { _id: unknown; count: number; entity: { slug: string; name: Name; kind?: string | null } };

/** How many entries each ranking keeps. */
export const TOP_SIZE = 10;
/** Company roles that get their own ranking (`unspecified` says nothing about the company). */
const RANKED_ROLES = COMPANY_ROLES.filter((r) => r !== "unspecified");

/** `period.start` within the calendar year (UTC). */
export function yearFilter(year: number): Record<string, unknown> {
  return { "period.start": { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) } };
}

/** Collabs per linked entity, each collab counted once, joined with the entity's current slug and name. */
function ranking(array: "parties" | "companies", idField: string, match: Record<string, unknown>, from: string) {
  return [
    { $unwind: `$${array}` },
    { $match: { ...match, [`${array}.${idField}`]: { $ne: null } } },
    { $group: { _id: `$${array}.${idField}`, collabs: { $addToSet: "$_id" } } },
    { $project: { count: { $size: "$collabs" } } },
    { $sort: { count: -1 as const, _id: 1 as const } },
    { $limit: TOP_SIZE },
    { $lookup: { from, localField: "_id", foreignField: "_id", as: "entity", pipeline: [{ $project: { slug: 1, name: 1, kind: 1 } }] } },
    { $unwind: "$entity" },
  ];
}

/**
 * Counts and distributions over published collabs matching `filter`.
 * `years` ignores `year` (it lists every year that has collabs, for picking one), the rest honour it.
 */
export async function stats(filter: Record<string, unknown>, locale: Locale, tax: TaxonomyIndex, now = new Date(), year?: number) {
  const scoped = year ? { $and: [filter, yearFilter(year)] } : filter;
  const byField = (field: string) => [{ $unwind: `$${field}` }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 as const } }];
  const properties = Property.collection.name;
  const companies = Company.collection.name;
  const [[result], years] = await Promise.all([
    Collab.aggregate<
      {
        total: { n: number }[];
        undated: { n: number }[];
        monthly: Bucket[];
        category: Bucket[];
        partnerCategory: Bucket[];
        region: Bucket[];
        platform: Bucket[];
        collabType: Bucket[];
        topHosts: Ranked[];
        topPartners: Ranked[];
      } & Record<`phase_${(typeof PHASES)[number]}`, { n: number }[]> &
        Record<`company_${(typeof RANKED_ROLES)[number]}`, Ranked[]>
    >([
      { $match: scoped },
      {
        $facet: {
          total: [{ $count: "n" }],
          undated: [{ $match: { "period.start": null } }, { $count: "n" }],
          monthly: [
            { $match: { "period.start": { $ne: null } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$period.start" } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
          category: [{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          // Collabs per partner kind: a collab with two anime partners counts once for anime.
          partnerCategory: [
            { $unwind: "$parties" },
            { $match: { "parties.role": "partner" } },
            { $group: { _id: { collab: "$_id", kind: "$parties.kind" } } },
            { $group: { _id: "$_id.kind", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ],
          region: byField("regions"),
          platform: byField("platforms"),
          collabType: byField("collabTypes"),
          topHosts: ranking("parties", "propertyId", { "parties.role": "host" }, properties),
          topPartners: ranking("parties", "propertyId", { "parties.role": "partner" }, properties),
          ...Object.fromEntries(RANKED_ROLES.map((r) => [`company_${r}`, ranking("companies", "companyId", { "companies.role": r }, companies)])),
          ...Object.fromEntries(PHASES.map((p) => [`phase_${p}`, [{ $match: phaseFilter(p, now) }, { $count: "n" }]])),
        },
      },
    ]),
    Collab.aggregate<{ _id: number; count: number }>([
      { $match: filter },
      { $match: { "period.start": { $ne: null } } },
      { $group: { _id: { $year: "$period.start" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const label = (buckets: Bucket[] = []) =>
    buckets.filter((b) => b._id).map((b) => ({ key: b._id!, label: tax.label(b._id!, locale), count: b.count }));
  const ranked = (rows: Ranked[] = [], withKind = false) =>
    rows.map((r) => ({
      slug: r.entity.slug,
      name: pick(r.entity.name, locale),
      ...(withKind ? { kind: tax.labeled(r.entity.kind, locale) } : {}),
      count: r.count,
    }));
  return {
    year: year ?? null,
    total: result?.total[0]?.n ?? 0,
    /** Collabs without a start date: left out of `monthly` and `years`. */
    undated: result?.undated[0]?.n ?? 0,
    byPhase: Object.fromEntries(PHASES.map((p) => [p, result?.[`phase_${p}`]?.[0]?.n ?? 0])) as Record<(typeof PHASES)[number], number>,
    monthly: (result?.monthly ?? []).map((b) => ({ month: b._id, count: b.count })),
    years: years.map((y) => ({ year: y._id, count: y.count })),
    category: label(result?.category),
    partnerCategory: label(result?.partnerCategory),
    region: label(result?.region),
    platform: label(result?.platform),
    collabType: label(result?.collabType),
    topHosts: ranked(result?.topHosts, true),
    topPartners: ranked(result?.topPartners, true),
    topCompanies: Object.fromEntries(RANKED_ROLES.map((r) => [r, ranked(result?.[`company_${r}`])])) as Record<
      (typeof RANKED_ROLES)[number],
      ReturnType<typeof ranked>
    >,
  };
}
