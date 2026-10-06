import { Schema, model, type InferSchemaType } from "mongoose";
import { TAXONOMIES } from "@gamecollabs/schema";

const taxonomyTermSchema = new Schema(
  {
    _id: { type: String, required: true },
    taxonomy: { type: String, enum: TAXONOMIES, required: true },
    parent: { type: String, default: null },
    ancestors: { type: [String], default: [] },
    label: {
      ko: { type: String, required: true },
      en: { type: String, required: true },
    },
    order: { type: Number, default: 0 },
    deprecated: { type: Boolean, default: false },
    legacyValues: { type: [String], default: [] },
  },
  { timestamps: true, collection: "taxonomy_terms" },
);

taxonomyTermSchema.index({ taxonomy: 1, order: 1 });

export type TaxonomyTermDoc = InferSchemaType<typeof taxonomyTermSchema> & { _id: string };
export const TaxonomyTerm = model("TaxonomyTerm", taxonomyTermSchema);
