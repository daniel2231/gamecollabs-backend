import { z } from "zod";
import { HttpUrl, IsoDateOrMonth, Slug } from "./common.js";
import { CompanyRole, EndKind, SourceType } from "./collab.js";

export const MAX_CANDIDATES_PER_CALL = 20;

const Name = z.string().trim().min(1).max(200);
/** Free-form classification value; the server maps it to a taxonomy key (`Android`, `platform.android`). */
const TaxonomyValue = z.string().trim().min(1).max(80);

/**
 * One collab found by an automated collector (GPT, agents). Names and
 * classification values are free text; the server resolves them.
 */
export const IngestCandidate = z.object({
    title: z.object({ ko: Name, en: Name }),
    summary: z.object({ ko: z.string().trim().min(1).max(4000), en: z.string().trim().min(1).max(4000) }),
    game: z.object({ name: Name, slug: Slug.nullish() }),
    partner: z.object({ name: Name, slug: Slug.nullish(), kind: TaxonomyValue.nullish() }),
    companies: z.array(z.object({ name: Name, role: CompanyRole.default("unspecified") })).max(10).default([]),
    category: TaxonomyValue.nullish(),
    regions: z.array(TaxonomyValue).max(20).default([]),
    platforms: z.array(TaxonomyValue).max(20).default([]),
    collabTypes: z.array(TaxonomyValue).max(20).default([]),
    period: z.object({
      start: IsoDateOrMonth,
      end: IsoDateOrMonth.nullish(),
      endKind: EndKind.default("fixed"),
    }),
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

export const SubmissionInput = z.object({
  url: HttpUrl,
  note: z.string().trim().max(1000).optional(),
  locale: z.enum(["ko", "en"]).optional(),
  /** Honeypot: must be empty. */
  website: z.string().max(0, "spam").optional(),
  turnstileToken: z.string().max(4096).optional(),
});
export type SubmissionInput = z.infer<typeof SubmissionInput>;
