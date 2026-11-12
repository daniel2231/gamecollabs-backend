import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

/**
 * Site members who signed in with Discord. Kept apart from `users` (staff accounts
 * and API tokens) so a member can never be given an admin role by mistake.
 */
const memberSchema = new Schema(
  {
    discordId: { type: String, required: true },
    username: { type: String, required: true },
    globalName: { type: String, default: null },
    /** Discord avatar hash; the web builds the CDN URL. */
    avatar: { type: String, default: null },
    /** Disabled members cannot sign in and their sessions stop working. */
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "members" },
);
memberSchema.index({ discordId: 1 }, { unique: true });
export type MemberDoc = HydratedDocument<InferSchemaType<typeof memberSchema>>;
export const Member = model("Member", memberSchema);

/** A collab a member saved. The collab is referenced by id, so slug changes keep the bookmark. */
const bookmarkSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    collabId: { type: Schema.Types.ObjectId, ref: "Collab", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "bookmarks" },
);
bookmarkSchema.index({ memberId: 1, collabId: 1 }, { unique: true });
bookmarkSchema.index({ memberId: 1, createdAt: -1, _id: -1 });
bookmarkSchema.index({ collabId: 1 });
export const Bookmark = model("Bookmark", bookmarkSchema);

/**
 * A property or company a member follows. Entity merges move follows to the
 * surviving entity (services/entities.ts), so a follow never points at a deleted one.
 */
const followSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    targetType: { type: String, enum: ["property", "company"], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "follows" },
);
followSchema.index({ memberId: 1, targetType: 1, targetId: 1 }, { unique: true });
followSchema.index({ memberId: 1, createdAt: -1 });
followSchema.index({ targetType: 1, targetId: 1 });
export const Follow = model("Follow", followSchema);
