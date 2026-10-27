import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const bodySchema = new Schema({ ko: { type: String, required: true }, en: { type: String, required: true } }, { _id: false });

/** Release notes shown on the web's changelog page (Markdown body in Korean and English). */
const changelogSchema = new Schema(
  {
    version: { type: String, required: true },
    /** Release day, UTC midnight. */
    date: { type: Date, required: true },
    body: { type: bodySchema, required: true },
    published: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: "changelog" },
);
changelogSchema.index({ version: 1 }, { unique: true });
changelogSchema.index({ published: 1, date: -1, createdAt: -1 });
export type ChangelogDoc = HydratedDocument<InferSchemaType<typeof changelogSchema>>;
export const Changelog = model("Changelog", changelogSchema);
