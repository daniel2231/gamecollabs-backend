import { z } from "zod";
import { Bilingual, CsvList, HttpUrl, IsoDate, IsoDateOrMonth, Locale, ObjectIdString, Slug, patchOf } from "./common.js";
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
/**
 * - `fixed`: an end date is announced.
 * - `permanent`: the content stays (store items, unlocked stickers, map additions).
 * - `tba`: the end has not been announced yet and is expected to be (re-checked).
 * - `conditional`: the collab ends on a condition rather than a date (see `END_CONDITIONS`).
 */
export const END_KINDS = ["fixed", "permanent", "tba", "conditional"] as const;
export const EndKind = z.enum(END_KINDS);
export type EndKind = z.infer<typeof EndKind>;

/**
 * Why a `conditional` collab has no end date:
 * - `sold_out`: sold while stocks last, shop by shop ("なくなり次第終了");
 * - `tied_event`: ends with another event whose date is not out yet ("until the next pack's maintenance");
 * - `other`: any other stated condition (describe it in `endNote`).
 */
export const END_CONDITIONS = ["sold_out", "tied_event", "other"] as const;
export const EndCondition = z.enum(END_CONDITIONS);
export type EndCondition = z.infer<typeof EndCondition>;

/**
 * A `conditional` collab without an `expectedEnd` is shown as ongoing for this many days after its
 * start, then as ended. This is a display rule, not a date stored as the collab's end.
 */
export const CONDITIONAL_DEFAULT_DAYS = 60;

export const ORIGIN_TYPES = ["manual", "gpt", "agent", "migration"] as const;

const Text = (max: number) => z.string().trim().max(max).nullish();

const Required = (max: number) => z.string().trim().min(1).max(max);

export const CollabLocaleText = z.object({
  title: Required(200),
  summary: Required(4000),
  note: Text(2000),
});

/** Korean and English are both required: title and summary in each language, a note in both or neither. */
export const CollabI18n = z
  .object({
    ko: CollabLocaleText,
    en: CollabLocaleText,
  })
  .refine((t) => !t.ko.note === !t.en.note, { message: "note must be given in both languages or neither", path: ["en", "note"] });

export const PartyInput = z
  .object({
    propertyId: ObjectIdString.nullish(),
    role: PartyRole,
    /** partner_category key. Taken from the property when omitted. */
    kind: keyOf("partner_category").nullish(),
    /** Only used for parties not yet linked to a property (drafts). */
    name: Bilingual(200).nullish(),
  })
  .refine((p) => p.propertyId || p.name, {
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
    /** Required with `endKind: "conditional"`, not allowed otherwise. */
    endCondition: EndCondition.nullish(),
    /** The condition as the source states it, e.g. "제11탄 업데이트 점검까지" / "Until the 11th pack's maintenance". */
    endNote: Bilingual(200).nullish(),
    /**
     * Only for `conditional`, and only when a source gives an approximate end ("late December" → `YYYY-MM`).
     * Never a guess: leave it out when nothing is stated.
     */
    expectedEnd: IsoDateOrMonth.nullish(),
  })
  .refine((p) => !(p.end && !p.start), { message: "end requires start", path: ["end"] })
  .refine((p) => !(p.start && p.end && p.end < p.start), { message: "end is before start", path: ["end"] })
  .refine((p) => !(p.endKind !== "fixed" && p.end), {
    message: "permanent/tba/conditional periods have no end date",
    path: ["end"],
  })
  .refine((p) => p.endKind !== "conditional" || !!p.endCondition, {
    message: "conditional periods need endCondition",
    path: ["endCondition"],
  })
  .refine((p) => p.endKind === "conditional" || (!p.endCondition && !p.endNote && !p.expectedEnd), {
    message: "endCondition, endNote and expectedEnd are only for conditional periods",
    path: ["endKind"],
  })
  .refine((p) => !(p.start && p.expectedEnd && p.expectedEnd.slice(0, 7) < p.start.slice(0, 7)), {
    message: "expectedEnd is before start",
    path: ["expectedEnd"],
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

/**
 * Where an offline collab takes place (shop, café, venue). The name is shown to readers, so it
 * is required in Korean and English; the address is kept as officially written (local language).
 */
export const VenueInput = z.object({
  name: Bilingual(200),
  address: z.string().trim().min(1).max(300).nullish(),
  url: HttpUrl.nullish(),
});
export type VenueInput = z.infer<typeof VenueInput>;

export const CoverInput = z.object({
  originalUrl: HttpUrl.nullish(),
  storageKey: z.string().max(512).nullish(),
  credit: Text(120),
  alt: Bilingual(300).nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
});

export const CollabInput = z.object({
  slug: Slug.optional(),
  i18n: CollabI18n,
  parties: z.array(PartyInput).max(10).default([]),
  companies: z.array(CompanyRefInput).max(20).default([]),
  category: keyOf("category").nullish(),
  regions: z.array(keyOf("region")).max(30).default([]),
  platforms: z.array(keyOf("platform")).max(30).default([]),
  collabTypes: z.array(keyOf("collab_type")).max(30).default([]),
  period: PeriodInput.default({ endKind: "fixed" }),
  /** Announced, but what it adds (items, skins, events) is not out yet; re-checked until cleared. */
  contentTba: z.boolean().default(false),
  sources: z.array(SourceInput).min(1).max(20),
  cover: CoverInput.nullish(),
  /** Offline collabs only; several for chain-wide campaigns. */
  venues: z.array(VenueInput).max(20).default([]),
});
export type CollabInput = z.infer<typeof CollabInput>;

/** PATCH body: each present top-level field replaces the stored value. */
export const CollabPatch = patchOf(CollabInput).extend({
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

/**
 * `current` (default) puts what matters now first: ongoing (newest start first), upcoming (soonest first),
 * ended (most recently ended first), then unknown. `recent` orders by first publication (newest first), for feeds.
 */
export const SORTS = ["current", "start_desc", "start_asc", "recent"] as const;

/** Query of `GET /v1/collabs`. */
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
  sort: z.enum(SORTS).default("current"),
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
}).extend({
  /** Only collabs that start in this calendar year (UTC). */
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type StatsQuery = z.infer<typeof StatsQuery>;

export { TaxonomyKey };
