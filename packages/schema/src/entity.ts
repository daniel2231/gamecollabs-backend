import { z } from "zod";
import { EntityName, HttpUrl, ObjectIdString, Slug } from "./common.js";
import { keyOf } from "./taxonomy.js";

const Aliases = z.array(z.string().trim().min(1).max(200)).max(50);

export const PropertyInput = z.object({
  slug: Slug,
  kind: keyOf("partner_category"),
  name: EntityName,
  aliases: Aliases.default([]),
  parentId: ObjectIdString.nullish(),
  officialUrl: HttpUrl.nullish(),
});
export type PropertyInput = z.infer<typeof PropertyInput>;

export const PropertyPatch = PropertyInput.partial();
export type PropertyPatch = z.infer<typeof PropertyPatch>;

export const CompanyInput = z.object({
  slug: Slug,
  name: EntityName,
  aliases: Aliases.default([]),
  /** ISO 3166-1 alpha-2 */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "expected ISO 3166-1 alpha-2 (e.g. JP)")
    .nullish(),
});
export type CompanyInput = z.infer<typeof CompanyInput>;

export const CompanyPatch = CompanyInput.partial();
export type CompanyPatch = z.infer<typeof CompanyPatch>;

/** `POST /v1/admin/{properties|companies}/:id/merge`: `from` is absorbed into `:id`. */
export const MergeInput = z.object({ from: ObjectIdString });

export const EntitySearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
