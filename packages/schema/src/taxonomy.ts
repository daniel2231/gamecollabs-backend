import { z } from "zod";

export const TAXONOMIES = ["category", "partner_category", "region", "platform", "collab_type"] as const;
export const Taxonomy = z.enum(TAXONOMIES);
export type Taxonomy = z.infer<typeof Taxonomy>;

/** A taxonomy key such as `platform.android`: `<taxonomy>.<snake_case_term>`. */
export const TaxonomyKey = z
  .string()
  .regex(
    /^(category|partner_category|region|platform|collab_type)\.[a-z0-9]+(?:_[a-z0-9]+)*$/,
    "invalid taxonomy key",
  );

export const keyOf = <T extends Taxonomy>(taxonomy: T) =>
  TaxonomyKey.refine((k) => k.startsWith(`${taxonomy}.`), `expected a ${taxonomy}.* key`);

export function taxonomyOfKey(key: string): Taxonomy | null {
  const prefix = key.split(".", 1)[0];
  return (TAXONOMIES as readonly string[]).includes(prefix ?? "") ? (prefix as Taxonomy) : null;
}

export const TaxonomyTermInput = z.object({
  key: TaxonomyKey,
  parent: TaxonomyKey.nullish(),
  label: z.object({ ko: z.string().trim().min(1).max(80), en: z.string().trim().min(1).max(80) }),
  order: z.number().int().default(0),
  legacyValues: z.array(z.string().trim().min(1).max(80)).default([]),
});
export type TaxonomyTermInput = z.infer<typeof TaxonomyTermInput>;

export const TaxonomyTermPatch = z
  .object({
    parent: TaxonomyKey.nullable(),
    label: z.object({ ko: z.string().trim().min(1).max(80), en: z.string().trim().min(1).max(80) }),
    order: z.number().int(),
    deprecated: z.boolean(),
    legacyValues: z.array(z.string().trim().min(1).max(80)),
  })
  .partial();
export type TaxonomyTermPatch = z.infer<typeof TaxonomyTermPatch>;
