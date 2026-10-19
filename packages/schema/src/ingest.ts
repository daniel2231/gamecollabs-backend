import { z } from "zod";
import { HttpUrl, IsoDateOrMonth, Slug } from "./common.js";
import { CompanyRole, EndKind, SourceType, VenueInput } from "./collab.js";

export const MAX_CANDIDATES_PER_CALL = 20;

const Name = z.string().trim().min(1).max(200);
/** Free-form classification value; the server maps it to a taxonomy key (`Android`, `platform.android`). */
const TaxonomyValue = z.string().trim().min(1).max(80);

/**
 * Official Korean and English names (and the original-script name, e.g. Japanese).
 * When no existing game/IP/company matches, the server creates one from these so
 * the draft is linked; without them the name is kept for the reviewer.
 */
const EntityNames = z.object({ ko: Name, en: Name, original: Name.nullish() });

/**
 * One collab found by an automated collector (GPT, agents). Names and
 * classification values are free text; the server resolves them.
 */
export const IngestCandidate = z.object({
    title: z.object({ ko: Name, en: Name }),
    summary: z.object({ ko: z.string().trim().min(1).max(4000), en: z.string().trim().min(1).max(4000) }),
    game: z.object({ name: Name, slug: Slug.nullish(), names: EntityNames.nullish() }),
    partner: z.object({ name: Name, slug: Slug.nullish(), kind: TaxonomyValue.nullish(), names: EntityNames.nullish() }),
    companies: z
      .array(
        z.object({
          name: Name,
          role: CompanyRole.default("unspecified"),
          slug: Slug.nullish(),
          names: EntityNames.nullish(),
          /** ISO 3166-1 alpha-2 of the headquarters (e.g. JP), used when the company is created. */
          country: z.string().regex(/^[A-Z]{2}$/, "expected ISO 3166-1 alpha-2 (e.g. JP)").nullish(),
        }),
      )
      .max(10)
      .default([]),
    category: TaxonomyValue.nullish(),
    regions: z.array(TaxonomyValue).max(20).default([]),
    platforms: z.array(TaxonomyValue).max(20).default([]),
    collabTypes: z.array(TaxonomyValue).max(20).default([]),
    /**
     * Leave `start` out when the start date has not been announced: the
     * candidate is stored as a draft and cannot be published until a date is set.
     */
    period: z
      .object({
        start: IsoDateOrMonth.nullish(),
        end: IsoDateOrMonth.nullish(),
        endKind: EndKind.default("tba"),
      })
      .refine((p) => !(p.end && !p.start), { message: "end requires start", path: ["end"] })
      .default({ endKind: "tba" }),
    sources: z
      .array(
        z.object({
          url: HttpUrl,
          title: z.string().trim().max(300).nullish(),
          publisher: z.string().trim().max(120).nullish(),
          type: SourceType.default("press"),
        }),
      )
      .min(1)
      .max(5),
    coverImageUrl: HttpUrl.nullish(),
    /** Offline collabs: where it happens (name in ko/en, address as officially written). */
    venues: z.array(VenueInput).max(20).default([]),
    confidence: z.number().min(0).max(1).nullish(),
    notes: z.string().trim().max(2000).nullish(),
  });
export type IngestCandidate = z.infer<typeof IngestCandidate>;

/** Body of `POST /v1/ingest/candidates`. Items are validated one by one. */
export const IngestRequest = z.object({
  runId: z.string().trim().min(1).max(100).optional(),
  client: z.string().trim().min(1).max(60).default("unknown"),
  model: z.string().trim().max(100).optional(),
  candidates: z.array(z.unknown()).min(1).max(MAX_CANDIDATES_PER_CALL),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const INGEST_OUTCOMES = ["created", "duplicate", "rejected"] as const;

export type IngestItemResult = {
  index: number;
  status: (typeof INGEST_OUTCOMES)[number];
  id?: string;
  slug?: string;
  reasons?: { code: string; message: string }[];
  warnings?: string[];
  unmapped?: Record<string, string[]>;
};

export type IngestResponse = {
  runId: string;
  results: IngestItemResult[];
  summary: { created: number; duplicate: number; rejected: number };
};

export const SUBMISSION_KINDS = ["tip", "correction"] as const;
export const SUBMISSION_STATUSES = ["new", "accepted", "dismissed"] as const;

/**
 * Visitor report relayed by the Next.js server.
 * tip: a collab we do not list yet (url required).
 * correction: something wrong on a published collab (collab slug and note required, url optional).
 */
export const SubmissionInput = z
  .object({
    kind: z.enum(SUBMISSION_KINDS).default("tip"),
    url: HttpUrl.optional(),
    collab: Slug.optional(),
    note: z.string().trim().max(1000).optional(),
    locale: z.enum(["ko", "en"]).optional(),
    /** Honeypot: must be empty. */
    website: z.string().max(0, "spam").optional(),
    turnstileToken: z.string().max(4096).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "tip") {
      if (!v.url) ctx.addIssue({ code: "custom", path: ["url"], message: "required" });
      return;
    }
    if (!v.collab) ctx.addIssue({ code: "custom", path: ["collab"], message: "required" });
    if (!v.note || v.note.length < 5) ctx.addIssue({ code: "custom", path: ["note"], message: "describe what is wrong (5+ characters)" });
  });
export type SubmissionInput = z.infer<typeof SubmissionInput>;
