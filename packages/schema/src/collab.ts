import { z } from "zod";
import { CsvList, HttpUrl, IsoDate, IsoDateOrMonth, Locale, ObjectIdString, Slug } from "./common.js";
import { TaxonomyKey, keyOf } from "./taxonomy.js";

export const COLLAB_STATUSES = ["draft", "in_review", "published", "archived"] as const;
export const CollabStatus = z.enum(COLLAB_STATUSES);
export type CollabStatus = z.infer<typeof CollabStatus>;

export const PHASES = ["upcoming", "ongoing", "ended", "unknown"] as const;
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

export const PARTY_ROLES = ["host", "partner"] as const;
export const PartyRole = z.enum(PARTY_ROLES);

/**
 * `unspecified` covers data migrated from the MVP, where companies had no role.
 * Everything else follows the PRD.
 */
export const COMPANY_ROLES = ["publisher", "developer", "licensor", "brand_partner", "organizer", "unspecified"] as const;
export const CompanyRole = z.enum(COMPANY_ROLES);
export type CompanyRole = z.infer<typeof CompanyRole>;

export const SOURCE_TYPES = ["official", "press", "social", "store"] as const;
export const SourceType = z.enum(SOURCE_TYPES);

export const PRECISIONS = ["day", "month", "unknown"] as const;
export const Precision = z.enum(PRECISIONS);
export const END_KINDS = ["fixed", "permanent", "tba"] as const;
export const EndKind = z.enum(END_KINDS);

export const ORIGIN_TYPES = ["manual", "gpt", "agent", "migration"] as const;

const Text = (max: number) => z.string().trim().max(max).nullish();

export const CollabLocaleText = z.object({
  title: Text(200),
  summary: Text(4000),
  note: Text(2000),
});

export const CollabI18n = z.object({
  ko: CollabLocaleText.default({}),
  en: CollabLocaleText.extend({ machineTranslated: z.boolean().optional() }).default({}),
});

export const PartyInput = z
  .object({
    propertyId: ObjectIdString.nullish(),
    role: PartyRole,
    /** partner_category key. Taken from the property when omitted. */
    kind: keyOf("partner_category").nullish(),
    /** Only used for parties not yet linked to a property (drafts). */
    name: z.object({ ko: Text(200), en: Text(200) }).nullish(),
  })
  .refine((p) => p.propertyId || p.name?.ko || p.name?.en, {
    message: "either propertyId or name is required",
  });
export type PartyInput = z.infer<typeof PartyInput>;

export const CompanyRefInput = z.object({
  companyId: ObjectIdString,
  role: CompanyRole,
});

export const PeriodInput = z
  .object({
    start: IsoDateOrMonth.nullish(),
    end: IsoDateOrMonth.nullish(),
    /** Derived from the date format when omitted. */
    precision: Precision.optional(),
    endKind: EndKind.default("fixed"),
  })
  .refine((p) => !(p.end && !p.start), { message: "end requires start", path: ["end"] })
  .refine((p) => !(p.start && p.end && p.end < p.start), { message: "end is before start", path: ["end"] })
  .refine((p) => !(p.endKind !== "fixed" && p.end), {
    message: "permanent/tba periods have no end date",
    path: ["end"],
  });
export type PeriodInput = z.infer<typeof PeriodInput>;

export const SourceInput = z.object({
  url: HttpUrl,
  title: Text(300),
  publisher: Text(120),
  type: SourceType.default("press"),
  isPrimary: z.boolean().default(false),
  accessedAt: IsoDate.nullish(),
  archiveUrl: HttpUrl.nullish(),
});
export type SourceInput = z.infer<typeof SourceInput>;

export const CoverInput = z.object({
  originalUrl: HttpUrl.nullish(),
  storageKey: z.string().max(512).nullish(),
  credit: Text(120),
  alt: z.object({ ko: Text(300), en: Text(300) }).nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});

export const CollabInput = z.object({
  slug: Slug.optional(),
  i18n: CollabI18n.default({ ko: {}, en: {} }),
  parties: z.array(PartyInput).max(10).default([]),
  companies: z.array(CompanyRefInput).max(20).default([]),
  category: keyOf("category").nullish(),
  regions: z.array(keyOf("region")).max(30).default([]),
  platforms: z.array(keyOf("platform")).max(30).default([]),
  collabTypes: z.array(keyOf("collab_type")).max(30).default([]),
  period: PeriodInput.default({ endKind: "fixed" }),
  sources: z.array(SourceInput).min(1).max(20),
  cover: CoverInput.nullish(),
});
export type CollabInput = z.infer<typeof CollabInput>;

/** PATCH body: each present top-level field replaces the stored value. */
export const CollabPatch = CollabInput.partial().extend({
  sources: z.array(SourceInput).min(1).max(20).optional(),
});
export type CollabPatch = z.infer<typeof CollabPatch>;

export const TRANSITION_ACTIONS = ["submit", "publish", "archive", "reject", "reopen"] as const;
export const TransitionInput = z
  .object({
    action: z.enum(TRANSITION_ACTIONS),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((t) => t.action !== "reject" || !!t.reason, { message: "reject requires a reason", path: ["reason"] });
export type TransitionInput = z.infer<typeof TransitionInput>;

export const SORTS = ["start_desc", "start_asc"] as const;

/** Query of `GET /v1/collabs` and `GET /v1/collabs/export.csv`. */
export const CollabListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: CsvList.pipe(z.array(keyOf("category"))).optional(),
  partner_category: CsvList.pipe(z.array(keyOf("partner_category"))).optional(),
  region: CsvList.pipe(z.array(keyOf("region"))).optional(),
  platform: CsvList.pipe(z.array(keyOf("platform"))).optional(),
  collab_type: CsvList.pipe(z.array(keyOf("collab_type"))).optional(),
  phase: CsvList.pipe(z.array(Phase)).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  property: CsvList.pipe(z.array(Slug)).optional(),
  company: CsvList.pipe(z.array(Slug)).optional(),
  locale: Locale.default("ko"),
  sort: z.enum(SORTS).default("start_desc"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export type CollabListQuery = z.infer<typeof CollabListQuery>;

/** Query of `GET /v1/admin/collabs` (all statuses). */
export const AdminCollabListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: CsvList.pipe(z.array(CollabStatus)).optional(),
  origin: CsvList.pipe(z.array(z.enum(ORIGIN_TYPES))).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminCollabListQuery = z.infer<typeof AdminCollabListQuery>;

export const StatsQuery = CollabListQuery.pick({
  category: true,
  partner_category: true,
  region: true,
  platform: true,
  collab_type: true,
  from: true,
  to: true,
  locale: true,
});

export { TaxonomyKey };
