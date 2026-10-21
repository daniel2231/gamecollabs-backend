import { z } from "zod";
import { EntityName, HttpUrl, Locale, ObjectIdString, Slug, patchOf } from "./common.js";
import { CoverInput } from "./collab.js";
import { keyOf } from "./taxonomy.js";

const Aliases = z.array(z.string().trim().min(1).max(200)).max(50);

/** Position on the home "browse by IP" row (smaller first); `null` keeps the property off it. */
export const FeaturedOrder = z.number().int().min(1).max(999);

const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

/** An empty credit and an alt with no text in either language are stored as null. */
function emptyToNull(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const image = { ...(value as Record<string, unknown>) };
  if (blank(image.credit)) image.credit = null;
  const alt = image.alt as Record<string, unknown> | null | undefined;
  if (alt === undefined || alt === null || (typeof alt === "object" && blank(alt.ko) && blank(alt.en))) image.alt = null;
  return image;
}

/** Representative image of a property: same shape and checks as a collab cover, but an image is required. */
export const PropertyImageInput = z.preprocess(
  emptyToNull,
  CoverInput.refine((c) => !!(c.storageKey || c.originalUrl), { message: "either storageKey or originalUrl is required" }),
);
export type PropertyImageInput = z.infer<typeof PropertyImageInput>;

export const PropertyInput = z.object({
  slug: Slug,
  kind: keyOf("partner_category"),
  name: EntityName,
  aliases: Aliases.default([]),
  parentId: ObjectIdString.nullish(),
  officialUrl: HttpUrl.nullish(),
  /**
   * Games only: the platforms the game ships on, as specific as known (`platform.android`, `platform.ps5`).
   * Its collabs show these; a collab has no platforms of its own.
   */
  platforms: z.array(keyOf("platform")).max(30).default([]),
  featuredOrder: FeaturedOrder.nullish(),
  image: PropertyImageInput.nullish(),
});
export type PropertyInput = z.infer<typeof PropertyInput>;

export const PropertyPatch = patchOf(PropertyInput);
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

export const CompanyPatch = patchOf(CompanyInput);
export type CompanyPatch = z.infer<typeof CompanyPatch>;

/** `POST /v1/admin/{properties|companies}/:id/merge`: `from` is absorbed into `:id`. */
export const MergeInput = z.object({ from: ObjectIdString });

/** Without `q` the whole list is returned (admin entity manager), most used first. */
export const EntitySearchQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Query of `GET /v1/properties`: only the featured list (home "browse by IP") is public. */
export const PropertyListQuery = z.object({
  featured: z.literal("true"),
  locale: Locale.default("ko"),
});
