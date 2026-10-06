import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ROLES = ["admin", "editor", "agent", "ingest"] as const;
export type Role = (typeof ROLES)[number];

/** Admin/editor accounts (GitHub login) and agent/ingest API tokens. */
const userSchema = new Schema(
  {
    kind: { type: String, enum: ["human", "token"], required: true },
    name: { type: String, required: true },
    githubLogin: { type: String, default: undefined, lowercase: true },
    role: { type: String, enum: ROLES, required: true },
    /** sha256 of the opaque token; the token itself is never stored. */
    tokenHash: { type: String, default: undefined, select: false },
    tokenPrefix: { type: String, default: null },
    active: { type: Boolean, default: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "users" },
);
userSchema.index({ githubLogin: 1 }, { unique: true, partialFilterExpression: { githubLogin: { $type: "string" } } });
userSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } } });
export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model("User", userSchema);

const revisionSchema = new Schema(
  {
    collabId: { type: Schema.Types.ObjectId, ref: "Collab", required: true },
    rev: { type: Number, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorLabel: { type: String, default: null },
    action: { type: String, required: true },
    diff: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "revisions", minimize: false },
);
revisionSchema.index({ collabId: 1, rev: -1 });
export const Revision = model("Revision", revisionSchema);

const submissionSchema = new Schema(
  {
    url: { type: String, required: true },
    note: { type: String, default: null },
    locale: { type: String, default: null },
    /** sha256(ip + secret) so abuse can be traced without storing the address. */
    ipHash: { type: String, default: null },
    status: { type: String, enum: ["new", "accepted", "dismissed"], default: "new" },
    collabId: { type: Schema.Types.ObjectId, ref: "Collab", default: null },
  },
  { timestamps: true, collection: "submissions" },
);
submissionSchema.index({ status: 1, createdAt: -1 });
export const Submission = model("Submission", submissionSchema);

const ingestRunSchema = new Schema(
  {
    runId: { type: String, required: true },
    channel: { type: String, required: true },
    client: { type: String, required: true },
    model: { type: String, default: null },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    calls: { type: Number, default: 0 },
    counts: {
      created: { type: Number, default: 0 },
      duplicate: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },
    items: { type: [Schema.Types.Mixed], default: [] },
    /** API cost of runs made by the OpenAI fallback collector. */
    costUsd: { type: Number, default: 0 },
    lastCallAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "ingest_runs" },
);
ingestRunSchema.index({ runId: 1 }, { unique: true });
ingestRunSchema.index({ createdAt: -1 });
export const IngestRun = model("IngestRun", ingestRunSchema);

/** Mutex for periodic jobs so two instances never run the same job at once. */
const jobLockSchema = new Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastResult: { type: Schema.Types.Mixed, default: null },
    lastError: { type: String, default: null },
  },
  { collection: "job_locks" },
);
export const JobLock = model("JobLock", jobLockSchema);
