import { PHASES, type Locale } from "@gamecollabs/schema";
import { phaseFilter } from "../lib/period.js";
import { Collab } from "../models/collab.js";
import type { TaxonomyIndex } from "./taxonomy.js";

type Bucket = { _id: string | null; count: number };

/** Monthly counts and distributions over published collabs matching `filter`. */
export async function stats(filter: Record<string, unknown>, locale: Locale, tax: TaxonomyIndex, now = new Date()) {
  const byField = (field: string) => [{ $unwind: `$${field}` }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { count: -1 as const } }];
  const [result] = await Collab.aggregate<{
    total: { n: number }[];
    monthly: Bucket[];
    category: Bucket[];
    partnerCategory: Bucket[];
    region: Bucket[];
    platform: Bucket[];
    collabType: Bucket[];
  } & Record<`phase_${(typeof PHASES)[number]}`, { n: number }[]>>([
    { $match: filter },
    {
      $facet: {
        total: [{ $count: "n" }],
        monthly: [
          { $match: { "period.start": { $ne: null } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$period.start" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        category: [{ $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        partnerCategory: [
          { $unwind: "$parties" },
          { $match: { "parties.role": "partner" } },
          { $group: { _id: "$parties.kind", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        region: byField("regions"),
        platform: byField("platforms"),
        collabType: byField("collabTypes"),
        ...Object.fromEntries(PHASES.map((p) => [`phase_${p}`, [{ $match: phaseFilter(p, now) }, { $count: "n" }]])),
      },
    },
  ]);
  const label = (buckets: Bucket[] = []) =>
    buckets.filter((b) => b._id).map((b) => ({ key: b._id!, label: tax.label(b._id!, locale), count: b.count }));
  return {
    total: result?.total[0]?.n ?? 0,
    byPhase: Object.fromEntries(PHASES.map((p) => [p, result?.[`phase_${p}`]?.[0]?.n ?? 0])) as Record<(typeof PHASES)[number], number>,
    monthly: (result?.monthly ?? []).map((b) => ({ month: b._id, count: b.count })),
    category: label(result?.category),
    partnerCategory: label(result?.partnerCategory),
    region: label(result?.region),
    platform: label(result?.platform),
    collabType: label(result?.collabType),
  };
}
