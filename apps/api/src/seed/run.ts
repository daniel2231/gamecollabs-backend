import type { Taxonomy } from "@gamecollabs/schema";
import { TaxonomyTerm } from "../models/taxonomyTerm.js";
import { invalidateTaxonomy } from "../services/taxonomy.js";
import { TAXONOMY_SEED } from "./taxonomy.js";

/** Inserts missing seed terms; with `update`, also overwrites labels, parents and legacy values. */
export async function seedTaxonomy(update: boolean) {
  let inserted = 0;
  let updated = 0;
  const ancestors = new Map<string, string[]>();
  for (const [order, seed] of TAXONOMY_SEED.entries()) {
    const parentAncestors = seed.parent ? (ancestors.get(seed.parent) ?? []) : [];
    const chain = seed.parent ? [...parentAncestors, seed.parent] : [];
    ancestors.set(seed.key, chain);
    const doc = {
      taxonomy: seed.key.split(".")[0] as Taxonomy,
      parent: seed.parent ?? null,
      ancestors: chain,
      label: seed.label,
      order,
      legacyValues: seed.legacyValues ?? [],
    };
    const exists = await TaxonomyTerm.exists({ _id: seed.key });
    if (!exists) {
      await TaxonomyTerm.create({ _id: seed.key, ...doc });
      inserted++;
    } else if (update) {
      await TaxonomyTerm.updateOne({ _id: seed.key }, doc);
      updated++;
    }
  }
  invalidateTaxonomy();
  return { inserted, updated };
}
