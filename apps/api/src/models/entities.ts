import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";
import { indexTokens, nameKey } from "../lib/text.js";

const nameSchema = new Schema(
  { ko: { type: String, default: null }, en: { type: String, default: null }, original: { type: String, default: null } },
  { _id: false },
);

const entityFields = {
  slug: { type: String, required: true },
  /** Slugs this entity had before a rename or merge; looked up for redirects. */
  formerSlugs: { type: [String], default: [] },
  name: { type: nameSchema, required: true },
  aliases: { type: [String], default: [] },
  /** Normalized names + aliases, for exact duplicate detection. */
  nameKeys: { type: [String], default: [], select: false },
  searchTokens: { type: [String], default: [], select: false },
  collabCount: { type: Number, default: 0 },
};

type Named = { name: { ko?: string | null; en?: string | null; original?: string | null }; aliases: string[] };

function deriveKeys(doc: Named & { nameKeys: string[]; searchTokens: string[] }) {
  const names = [doc.name.ko, doc.name.en, doc.name.original, ...doc.aliases].filter((n): n is string => !!n);
  doc.nameKeys = [...new Set(names.map(nameKey).filter(Boolean))];
  doc.searchTokens = indexTokens(...names);
}

const propertySchema = new Schema(
  {
    ...entityFields,
    /** partner_category key; games are `partner_category.game`. */
    kind: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Property", default: null },
    officialUrl: { type: String, default: null },
  },
  { timestamps: true, collection: "properties" },
);

const companySchema = new Schema(
  {
    ...entityFields,
    country: { type: String, default: null },
  },
  { timestamps: true, collection: "companies" },
);

for (const schema of [propertySchema, companySchema]) {
  schema.index({ slug: 1 }, { unique: true });
  schema.index({ formerSlugs: 1 });
  schema.index({ searchTokens: 1 });
  schema.index({ nameKeys: 1 });
  schema.pre("validate", function () {
    deriveKeys(this as unknown as Named & { nameKeys: string[]; searchTokens: string[] });
  });
}

export type PropertyDoc = HydratedDocument<InferSchemaType<typeof propertySchema>>;
export type CompanyDoc = HydratedDocument<InferSchemaType<typeof companySchema>>;
export const Property = model("Property", propertySchema);
export const Company = model("Company", companySchema);
