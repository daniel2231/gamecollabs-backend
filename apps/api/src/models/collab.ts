import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import {
  COLLAB_STATUSES,
  COMPANY_ROLES,
  END_KINDS,
  ORIGIN_TYPES,
  PARTY_ROLES,
  PRECISIONS,
  SOURCE_TYPES,
} from "@gamecollabs/schema";
import { indexTokens } from "../lib/text.js";
import { untilOf } from "../lib/period.js";
import { taxonomy } from "../services/taxonomy.js";

const str = { type: String, default: null };

const localeText = new Schema({ title: str, summary: str, note: str }, { _id: false });
const enText = new Schema(
  { title: str, summary: str, note: str, machineTranslated: { type: Boolean, default: false } },
  { _id: false },
);
const snapshotName = new Schema({ ko: str, en: str }, { _id: false });

const partySchema = new Schema(
  {
    /** null only in drafts whose party has not been linked to a property yet. */
    propertyId: { type: Schema.Types.ObjectId, ref: "Property", default: null },
    slug: str,
    role: { type: String, enum: PARTY_ROLES, required: true },
    kind: str,
    name: { type: snapshotName, default: () => ({}) },
  },
  { _id: false },
);

const companyRefSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    slug: str,
    role: { type: String, enum: COMPANY_ROLES, required: true },
    name: { type: snapshotName, default: () => ({}) },
  },
  { _id: false },
);

const sourceSchema = new Schema(
  {
    url: { type: String, required: true },
    title: str,
    publisher: str,
    type: { type: String, enum: SOURCE_TYPES, default: "press" },
    isPrimary: { type: Boolean, default: false },
    accessedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    httpStatus: { type: Number, default: null },
    archiveUrl: str,
  },
  { _id: false },
);

const coverSchema = new Schema(
  {
    storageKey: str,
    originalUrl: str,
    credit: str,
    alt: { type: snapshotName, default: () => ({}) },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    mirrorError: str,
  },
  { _id: false },
);

const collabSchema = new Schema(
  {
    slug: { type: String, required: true },
    status: { type: String, enum: COLLAB_STATUSES, default: "draft", required: true },
    i18n: {
      ko: { type: localeText, default: () => ({}) },
      en: { type: enText, default: () => ({}) },
    },
    parties: { type: [partySchema], default: [] },
    companies: { type: [companyRefSchema], default: [] },
    category: str,
    regions: { type: [String], default: [] },
    platforms: { type: [String], default: [] },
    collabTypes: { type: [String], default: [] },
    facetKeys: { type: [String], default: [] },
    period: {
      start: { type: Date, default: null },
      end: { type: Date, default: null },
      precision: { type: String, enum: PRECISIONS, default: "unknown" },
      endKind: { type: String, enum: END_KINDS, default: "fixed" },
      /** Exclusive end instant derived from end + precision; makes phase filters a range query. */
      until: { type: Date, default: null },
    },
    sources: {
      type: [sourceSchema],
      validate: { validator: (v: unknown[]) => v.length >= 1, message: "at least one source is required" },
    },
    cover: { type: coverSchema, default: null },
    review: {
      createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      publishedAt: { type: Date, default: null },
      rejection: {
        type: new Schema({ reason: String, at: Date, by: Schema.Types.ObjectId }, { _id: false }),
        default: null,
      },
    },
    origin: {
      type: { type: String, enum: ORIGIN_TYPES, default: "manual" },
      runId: str,
      client: str,
      model: str,
      confidence: { type: Number, default: null },
      /** Classification values the server could not map to a key (kept for the reviewer). */
      unmapped: { type: Schema.Types.Mixed, default: null },
      notes: str,
    },
    rev: { type: Number, default: 1 },
    searchTokens: { type: [String], default: [], select: false },
  },
  { timestamps: true, collection: "collabs", minimize: false },
);

collabSchema.index({ slug: 1 }, { unique: true });
collabSchema.index({ status: 1, "period.start": -1, _id: -1 });
collabSchema.index({ facetKeys: 1, "period.start": -1 });
collabSchema.index({ "parties.propertyId": 1, "period.start": -1 });
collabSchema.index({ "companies.companyId": 1 });
collabSchema.index({ searchTokens: 1 });
collabSchema.index({ "sources.url": 1 });
collabSchema.index({ status: 1, updatedAt: -1, _id: -1 });
collabSchema.index({ "origin.runId": 1, createdAt: -1 });

export type CollabFields = InferSchemaType<typeof collabSchema>;
export type CollabDoc = HydratedDocument<CollabFields>;

export function collabSearchTokens(doc: Pick<CollabFields, "i18n" | "parties" | "companies">): string[] {
  return indexTokens(
    doc.i18n?.ko?.title,
    doc.i18n?.en?.title,
    doc.i18n?.ko?.summary,
    doc.i18n?.en?.summary,
    ...doc.parties.flatMap((p) => [p.name?.ko, p.name?.en]),
    ...doc.companies.flatMap((c) => [c.name?.ko, c.name?.en]),
  );
}

/**
 * Before validation: check every taxonomy key against `taxonomy_terms`,
 * then derive `facetKeys` (keys + all ancestors + partner kinds),
 * `searchTokens` and `period.until`.
 */
collabSchema.pre("validate", async function () {
  const terms = await taxonomy();
  const fields = [
    ["category", "category", this.category ? [this.category] : []],
    ["regions", "region", this.regions],
    ["platforms", "platform", this.platforms],
    ["collabTypes", "collab_type", this.collabTypes],
    ["parties", "partner_category", this.parties.map((p) => p.kind).filter((k): k is string => !!k)],
  ] as const;
  for (const [path, tax, keys] of fields) {
    const checkDeprecated = this.isNew || this.isModified(path);
    for (const key of keys) {
      const problem = terms.problemWith(key, tax, { allowDeprecated: !checkDeprecated });
      if (problem) this.invalidate(path, `${key}: ${problem}`, key);
    }
  }

  const facetSources = [
    ...(this.category ? [this.category] : []),
    ...this.regions,
    ...this.platforms,
    ...this.collabTypes,
    ...this.parties.filter((p) => p.role === "partner" && p.kind).map((p) => p.kind!),
  ];
  this.facetKeys = terms.expand(facetSources);
  this.searchTokens = collabSearchTokens(this);
  this.set("period.until", untilOf(this.period?.end ?? null, (this.period?.precision ?? "unknown") as "day" | "month" | "unknown"));
});

collabSchema.pre("save", function () {
  if (!this.isNew && this.isModified()) this.rev = (this.rev ?? 0) + 1;
});

export const Collab = model("Collab", collabSchema);
