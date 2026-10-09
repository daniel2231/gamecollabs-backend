import { Types, type ClientSession } from "mongoose";
import { COLLAB_STATUSES, type CollabStatus } from "@gamecollabs/schema";
import type {
  AdminCollabListQuery,
  CollabInput,
  CollabListQuery,
  CollabPatch,
  PartyInput,
  SourceInput,
  TransitionInput,
} from "@gamecollabs/schema";
import { withTransaction } from "../db.js";
import { Collab, type CollabDoc, type CollabFields } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { Revision } from "../models/support.js";
import type { Principal } from "../auth/principal.js";
import { HttpError, badRequest, forbidden, notFound, validationFailed } from "../lib/errors.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";
import { revalidate } from "../lib/outbound.js";
import { parseDateInput, phaseFilter, toStoredPeriod } from "../lib/period.js";
import { slugify } from "../lib/text.js";
import { normalizeUrl } from "../lib/url.js";
import { search } from "../search/provider.js";

type Snapshot = { ko: string | null; en: string | null };

/** Name copy kept on collabs; entities always carry both languages. */
export function snapshotName(name: { ko?: string | null; en?: string | null }): Snapshot {
  return { ko: name.ko ?? null, en: name.en ?? null };
}

/* ------------------------------------------------------------------ input → document */

export function toSources(input: SourceInput[]) {
  const seen = new Set<string>();
  const sources = [];
  for (const s of input) {
    const url = normalizeUrl(s.url);
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: s.title ?? null,
      publisher: s.publisher ?? null,
      type: s.type,
      isPrimary: s.isPrimary,
      accessedAt: s.accessedAt ? parseDateInput(s.accessedAt) : null,
      archiveUrl: s.archiveUrl ?? null,
    });
  }
  // Exactly one primary source.
  const primary = sources.findIndex((s) => s.isPrimary);
  sources.forEach((s, i) => (s.isPrimary = i === (primary === -1 ? 0 : primary)));
  return sources;
}

async function resolveParties(parties: PartyInput[], session?: ClientSession) {
  const ids = parties.filter((p) => p.propertyId).map((p) => new Types.ObjectId(p.propertyId!));
  const props = await Property.find({ _id: { $in: ids } }, null, { session }).lean();
  const byId = new Map(props.map((p) => [p._id.toString(), p]));
  return parties.map((p, i) => {
    if (!p.propertyId) {
      return { propertyId: null, slug: null, role: p.role, kind: p.kind ?? null, name: snapshotName(p.name!) };
    }
    const prop = byId.get(p.propertyId);
    if (!prop) throw validationFailed({ [`parties.${i}.propertyId`]: ["property not found"] });
    return { propertyId: prop._id, slug: prop.slug, role: p.role, kind: p.kind ?? prop.kind, name: snapshotName(prop.name) };
  });
}

async function resolveCompanies(companies: CollabInput["companies"], session?: ClientSession) {
  const ids = companies.map((c) => new Types.ObjectId(c.companyId));
  const docs = await Company.find({ _id: { $in: ids } }, null, { session }).lean();
  const byId = new Map(docs.map((c) => [c._id.toString(), c]));
  return companies.map((c, i) => {
    const company = byId.get(c.companyId);
    if (!company) throw validationFailed({ [`companies.${i}.companyId`]: ["company not found"] });
    return { companyId: company._id, slug: company.slug, role: c.role, name: snapshotName(company.name) };
  });
}

function i18nOf(input: CollabInput["i18n"]) {
  return {
    ko: { title: input.ko.title, summary: input.ko.summary, note: input.ko.note ?? null },
    en: { title: input.en.title, summary: input.en.summary, note: input.en.note ?? null },
  };
}

function coverOf(input: CollabInput["cover"], previous?: CollabFields["cover"]) {
  if (!input) return null;
  const sameOriginal = previous && previous.originalUrl === (input.originalUrl ?? null);
  return {
    originalUrl: input.originalUrl ?? null,
    // A new original URL invalidates the mirrored copy unless a key is given explicitly.
    storageKey: input.storageKey ?? (sameOriginal ? previous.storageKey : null) ?? null,
    credit: input.credit ?? null,
    alt: { ko: input.alt?.ko ?? null, en: input.alt?.en ?? null },
    width: input.width ?? null,
    height: input.height ?? null,
    mirrorError: null,
  };
}

/** `<english-title-or-names>-<yyyy-mm>`, made unique with a numeric suffix. */
export async function uniqueSlug(
  base: { title?: string | null; names?: (string | null | undefined)[]; start?: Date | null },
  session?: ClientSession,
): Promise<string> {
  const month = base.start ? base.start.toISOString().slice(0, 7) : null;
  let stem = slugify(base.title ?? "") || slugify((base.names ?? []).filter(Boolean).join(" ")) || "collab";
  if (month && !stem.endsWith(month)) stem = `${stem}-${month}`;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (!(await Collab.exists({ slug: candidate }).session(session ?? null))) return candidate;
  }
  return `${stem}-${new Types.ObjectId().toString().slice(-6)}`;
}

/* ------------------------------------------------------------------ revisions */

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

const TRACKED = ["slug", "status", "i18n", "parties", "companies", "category", "regions", "platforms", "collabTypes", "period", "sources", "cover"] as const;

function snapshot(doc: CollabDoc): Record<string, unknown> {
  const obj = doc.toObject();
  return Object.fromEntries(TRACKED.map((k) => [k, plain(obj[k])]));
}

function diffOf(before: Record<string, unknown>, after: Record<string, unknown>) {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of TRACKED) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff[k] = { from: before[k], to: after[k] };
  }
  return diff;
}

async function recordRevision(doc: CollabDoc, actor: Principal, action: string, diff: unknown, session: ClientSession) {
  await Revision.create([{ collabId: doc._id, rev: doc.rev, actorId: actor.userId, actorLabel: actor.label, action, diff }], { session });
}

/* ------------------------------------------------------------------ cache tags & counts */

export function tagsFor(doc: Pick<CollabFields, "slug" | "parties" | "companies">, extraSlugs: string[] = []): string[] {
  return [
    "collabs",
    `collab:${doc.slug}`,
    ...extraSlugs.map((s) => `collab:${s}`),
    ...doc.parties.filter((p) => p.slug).map((p) => `property:${p.slug}`),
    ...doc.companies.filter((c) => c.slug).map((c) => `company:${c.slug}`),
  ];
}

/** Recomputes `collabCount` (published collabs) for the given entities. */
export async function recountEntities(
  propertyIds: (Types.ObjectId | null | undefined)[],
  companyIds: (Types.ObjectId | null | undefined)[],
  session?: ClientSession,
) {
  for (const id of new Set(propertyIds.filter(Boolean).map(String))) {
    const count = await Collab.countDocuments({ status: "published", "parties.propertyId": id }).session(session ?? null);
    await Property.updateOne({ _id: id }, { collabCount: count }, { session });
  }
  for (const id of new Set(companyIds.filter(Boolean).map(String))) {
    const count = await Collab.countDocuments({ status: "published", "companies.companyId": id }).session(session ?? null);
    await Company.updateOne({ _id: id }, { collabCount: count }, { session });
  }
}

const entityIds = (doc: Pick<CollabFields, "parties" | "companies">) => ({
  properties: doc.parties.map((p) => p.propertyId),
  companies: doc.companies.map((c) => c.companyId),
});

/* ------------------------------------------------------------------ duplicates */

const DUPLICATE_WINDOW_MS = 14 * 86_400_000;

/**
 * Same source URL, or the same host and partner property with a start date
 * within ±14 days (or both without a start date). Checks every status,
 * including drafts.
 */
export async function findDuplicates(
  c: { sourceUrls: string[]; hostIds: Types.ObjectId[]; partnerIds: Types.ObjectId[]; start: Date | null; excludeId?: Types.ObjectId },
  session?: ClientSession,
) {
  const or: Record<string, unknown>[] = [];
  if (c.sourceUrls.length) or.push({ "sources.url": { $in: c.sourceUrls } });
  if (c.hostIds.length && c.partnerIds.length) {
    or.push({
      $and: [
        { parties: { $elemMatch: { role: "host", propertyId: { $in: c.hostIds } } } },
        { parties: { $elemMatch: { role: "partner", propertyId: { $in: c.partnerIds } } } },
        c.start
          ? {
              "period.start": {
                $gte: new Date(c.start.getTime() - DUPLICATE_WINDOW_MS),
                $lte: new Date(c.start.getTime() + DUPLICATE_WINDOW_MS),
              },
            }
          : { "period.start": null },
      ],
    });
  }
  if (!or.length) return [];
  const docs = await Collab.find({ $or: or, ...(c.excludeId ? { _id: { $ne: c.excludeId } } : {}) }, null, { session })
    .select({ slug: 1, status: 1, i18n: 1, "period.start": 1, sources: 1 })
    .limit(10)
    .lean();
  return docs.map((d) => ({
    id: d._id.toString(),
    slug: d.slug,
    status: d.status,
    title: { ko: d.i18n?.ko?.title ?? null, en: d.i18n?.en?.title ?? null },
    start: d.period?.start?.toISOString().slice(0, 10) ?? null,
    reason: d.sources.some((s) => c.sourceUrls.includes(s.url)) ? ("same_source_url" as const) : ("same_parties_and_date" as const),
  }));
}

function duplicateQueryFor(doc: Pick<CollabFields, "sources" | "parties" | "period"> & { _id: Types.ObjectId }) {
  return {
    sourceUrls: doc.sources.map((s) => s.url),
    hostIds: doc.parties.filter((p) => p.role === "host" && p.propertyId).map((p) => p.propertyId!),
    partnerIds: doc.parties.filter((p) => p.role === "partner" && p.propertyId).map((p) => p.propertyId!),
    start: doc.period?.start ?? null,
    excludeId: doc._id,
  };
}

/* ------------------------------------------------------------------ create / patch */

export type CreateOptions = {
  origin?: Partial<CollabFields["origin"]>;
  session?: ClientSession;
};

/** Builds and saves a draft. Always `draft`, whoever calls it. */
export async function createDraft(input: CollabInput, actor: Principal, opts: CreateOptions = {}) {
  const run = async (session: ClientSession) => {
    const period = toStoredPeriod({
      start: input.period.start,
      end: input.period.end,
      precision: input.period.precision,
      endKind: input.period.endKind,
    });
    const parties = await resolveParties(input.parties, session);
    const companies = await resolveCompanies(input.companies, session);
    const slug =
      input.slug ??
      (await uniqueSlug({ title: input.i18n.en?.title, names: parties.map((p) => p.name.en), start: period.start }, session));
    if (input.slug && (await Collab.exists({ slug: input.slug }).session(session))) {
      throw new HttpError(409, "duplicate_key", "slug already exists", { slug: ["already exists"] });
    }
    const doc = new Collab({
      slug,
      status: "draft",
      i18n: i18nOf(input.i18n),
      parties,
      companies,
      category: input.category ?? null,
      regions: input.regions,
      platforms: input.platforms,
      collabTypes: input.collabTypes,
      period,
      sources: toSources(input.sources),
      cover: coverOf(input.cover),
      review: { createdBy: actor.userId },
      origin: { type: actor.role === "agent" ? "agent" : "manual", ...opts.origin },
    });
    await doc.save({ session });
    await recordRevision(doc, actor, "create", null, session);
    const duplicates = await findDuplicates(duplicateQueryFor(doc), session);
    return { doc, duplicates };
  };
  return opts.session ? run(opts.session) : withTransaction(run);
}

export async function getById(id: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(id)) throw notFound("collab");
  const doc = await Collab.findById(id, null, { session });
  if (!doc) throw notFound("collab");
  return doc;
}

function assertRev(doc: CollabDoc, ifMatch: number | null, required: boolean) {
  if (ifMatch === null) {
    if (required) throw new HttpError(428, "precondition_required", "If-Match: <rev> header is required");
    return;
  }
  if (doc.rev !== ifMatch) throw new HttpError(412, "rev_conflict", `stored rev is ${doc.rev}`);
}

/** PATCH: each present field replaces the stored one. Agents may only touch drafts. */
export async function patchCollab(id: string, patch: CollabPatch, ifMatch: number | null, actor: Principal) {
  const result = await withTransaction(async (session) => {
    const doc = await getById(id, session);
    assertRev(doc, ifMatch, true);
    if (actor.role === "agent" && doc.status !== "draft") throw forbidden("agents can only edit drafts");
    if (doc.status === "published" && !actor.scopes.has("collabs:publish")) {
      throw forbidden("only admins can edit published collabs");
    }
    const before = snapshot(doc);
    const oldSlug = doc.slug;
    const oldEntities = entityIds(doc);

    if (patch.slug !== undefined && patch.slug !== doc.slug) {
      if (await Collab.exists({ slug: patch.slug }).session(session)) {
        throw new HttpError(409, "duplicate_key", "slug already exists", { slug: ["already exists"] });
      }
      doc.slug = patch.slug;
    }
    if (patch.i18n !== undefined) doc.set("i18n", i18nOf(patch.i18n));
    if (patch.parties !== undefined) doc.set("parties", await resolveParties(patch.parties, session));
    if (patch.companies !== undefined) doc.set("companies", await resolveCompanies(patch.companies, session));
    if (patch.category !== undefined) doc.category = patch.category ?? null;
    if (patch.regions !== undefined) doc.regions = patch.regions;
    if (patch.platforms !== undefined) doc.platforms = patch.platforms;
    if (patch.collabTypes !== undefined) doc.collabTypes = patch.collabTypes;
    if (patch.period !== undefined) doc.set("period", toStoredPeriod(patch.period));
    if (patch.sources !== undefined) doc.set("sources", toSources(patch.sources));
    if (patch.cover !== undefined) doc.set("cover", coverOf(patch.cover, doc.cover));

    const diff = diffOf(before, snapshot(doc));
    if (Object.keys(diff).length === 0) return { doc, changed: false, oldSlug, oldEntities };
    if (doc.status === "published") assertPublishable(doc);
    await doc.save({ session });
    await recordRevision(doc, actor, "update", diff, session);
    if (doc.status === "published") {
      const now = entityIds(doc);
      await recountEntities([...oldEntities.properties, ...now.properties], [...oldEntities.companies, ...now.companies], session);
    }
    return { doc, changed: true, oldSlug, oldEntities };
  });
  if (result.changed && result.doc.status === "published") {
    revalidate(tagsFor(result.doc, result.oldSlug !== result.doc.slug ? [result.oldSlug] : []));
  }
  return result.doc;
}

/* ------------------------------------------------------------------ workflow */

/** Required before a collab can be (or stay) published. */
export function assertPublishable(doc: CollabDoc) {
  const fields: Record<string, string[]> = {};
  const add = (k: string, m: string) => (fields[k] ??= []).push(m);
  for (const locale of ["ko", "en"] as const) {
    if (!doc.i18n?.[locale]?.title) add(`i18n.${locale}.title`, "required to publish");
    if (!doc.i18n?.[locale]?.summary) add(`i18n.${locale}.summary`, "required to publish");
  }
  if (!doc.parties.some((p) => p.role === "host")) add("parties", "a host party is required");
  if (!doc.parties.some((p) => p.role === "partner")) add("parties", "a partner party is required");
  doc.parties.forEach((p, i) => {
    if (!p.propertyId) add(`parties.${i}.propertyId`, "link the party to a property before publishing");
    if (!p.kind) add(`parties.${i}.kind`, "required to publish");
  });
  if (!doc.category) add("category", "required to publish");
  if (!doc.period?.start) add("period.start", "required to publish");
  if (!doc.sources.length) add("sources", "at least one source is required");
  if (Object.keys(fields).length) throw validationFailed(fields, "collab is not publishable");
}

type Action = TransitionInput["action"];

const TRANSITIONS: Record<Action, { from: string[]; to: string; scope: "collabs:submit" | "collabs:publish" }> = {
  submit: { from: ["draft"], to: "in_review", scope: "collabs:submit" },
  publish: { from: ["draft", "in_review"], to: "published", scope: "collabs:publish" },
  archive: { from: ["draft", "in_review", "published"], to: "archived", scope: "collabs:submit" },
  reject: { from: ["draft", "in_review"], to: "archived", scope: "collabs:submit" },
  reopen: { from: ["in_review", "archived"], to: "draft", scope: "collabs:submit" },
};

/** draft → in_review → published → archived (plus reject/reopen). Publishing is admin-only. */
export async function transition(id: string, input: TransitionInput, ifMatch: number | null, actor: Principal) {
  const rule = TRANSITIONS[input.action];
  if (!actor.scopes.has(rule.scope)) throw forbidden(`${input.action} requires ${rule.scope}`);
  const result = await withTransaction(async (session) => {
    const doc = await getById(id, session);
    assertRev(doc, ifMatch, false);
    if (!rule.from.includes(doc.status)) {
      throw new HttpError(409, "invalid_transition", `cannot ${input.action} a ${doc.status} collab`);
    }
    if (doc.status === "published" && !actor.scopes.has("collabs:publish")) throw forbidden("only admins can archive published collabs");
    const wasPublished = doc.status === "published";
    if (input.action === "publish") {
      assertPublishable(doc);
      doc.set("review.reviewedBy", actor.userId);
      if (!doc.review?.publishedAt) doc.set("review.publishedAt", new Date());
      doc.set("review.rejection", null);
    }
    if (input.action === "reject") {
      doc.set("review.rejection", { reason: input.reason!, at: new Date(), by: actor.userId });
    }
    const from = doc.status;
    doc.status = rule.to as CollabDoc["status"];
    await doc.save({ session });
    await recordRevision(doc, actor, `transition:${input.action}`, { status: { from, to: doc.status }, reason: input.reason ?? null }, session);
    const ids = entityIds(doc);
    if (wasPublished || doc.status === "published") await recountEntities(ids.properties, ids.companies, session);
    return { doc, wasPublished };
  });
  if (result.wasPublished || result.doc.status === "published") revalidate(tagsFor(result.doc));
  return result.doc;
}

/* ------------------------------------------------------------------ queries */

async function idsForSlugs(model: typeof Property | typeof Company, slugs: string[]) {
  const docs = await (model as typeof Property).find({ $or: [{ slug: { $in: slugs } }, { formerSlugs: { $in: slugs } }] }).select({ _id: 1 }).lean();
  return docs.map((d) => d._id);
}

/** Facets: OR within a field, AND across fields; parent keys match children via `facetKeys`. */
export async function publicFilter(q: Omit<CollabListQuery, "locale" | "sort" | "cursor" | "limit">, now = new Date()) {
  const and: Record<string, unknown>[] = [{ status: "published" }];
  for (const values of [q.category, q.partner_category, q.region, q.platform, q.collab_type]) {
    if (values?.length) and.push({ facetKeys: { $in: values } });
  }
  if (q.phase?.length) and.push({ $or: q.phase.map((p) => phaseFilter(p, now)) });
  // Period overlaps [from, to].
  if (q.to) and.push({ "period.start": { $lt: new Date(parseDateInput(q.to).getTime() + 86_400_000) } });
  if (q.from) and.push({ $or: [{ "period.until": { $gt: parseDateInput(q.from) } }, { "period.until": null }] });
  if (q.property?.length) and.push({ "parties.propertyId": { $in: await idsForSlugs(Property, q.property) } });
  if (q.company?.length) and.push({ "companies.companyId": { $in: await idsForSlugs(Company, q.company) } });
  if (q.q) {
    const f = search.filter(q.q);
    if (f) and.push(f);
  }
  return { $and: and };
}

export async function listPublic(q: CollabListQuery, now = new Date()) {
  if (q.from && q.to && q.from > q.to) throw badRequest("invalid_range", "from is after to");
  const filter = await publicFilter(q, now);
  const dir = q.sort === "start_asc" ? 1 : -1;
  const field = q.sort === "recent" ? "review.publishedAt" : "period.start";
  const page = q.cursor ? { $and: [filter, afterCursor(field, dir, decodeCursor(q.cursor))] } : filter;
  const [items, total] = await Promise.all([
    Collab.find(page)
      .sort({ [field]: dir, _id: dir })
      .limit(q.limit + 1)
      .lean(),
    Collab.countDocuments(filter),
  ]);
  const hasMore = items.length > q.limit;
  const pageItems = items.slice(0, q.limit);
  const last = pageItems.at(-1);
  const lastValue = q.sort === "recent" ? last?.review?.publishedAt : last?.period?.start;
  return { items: pageItems, total, nextCursor: hasMore && last ? encodeCursor(lastValue ?? null, last._id) : null };
}

export async function listAdmin(q: AdminCollabListQuery) {
  const and: Record<string, unknown>[] = [];
  if (q.status?.length) and.push({ status: { $in: q.status } });
  if (q.origin?.length) and.push({ "origin.type": { $in: q.origin } });
  if (q.from) and.push({ "period.start": { $gte: parseDateInput(q.from) } });
  if (q.to) and.push({ "period.start": { $lt: new Date(parseDateInput(q.to).getTime() + 86_400_000) } });
  if (q.q) {
    const f = search.filter(q.q);
    if (f) and.push(f);
  }
  const filter = and.length ? { $and: and } : {};
  const page = q.cursor ? { $and: [filter, afterCursor("updatedAt", -1, decodeCursor(q.cursor))] } : filter;
  const items = await Collab.find(page).sort({ updatedAt: -1, _id: -1 }).limit(q.limit + 1).lean();
  const hasMore = items.length > q.limit;
  const pageItems = items.slice(0, q.limit);
  const last = pageItems.at(-1);
  return { items: pageItems, nextCursor: hasMore && last ? encodeCursor(last.updatedAt ?? null, last._id) : null };
}

export async function getPublishedBySlug(slug: string) {
  const doc = await Collab.findOne({ slug, status: "published" }).lean();
  if (!doc) throw notFound("collab");
  return doc;
}

/** Other published collabs sharing a property with this one. */
export async function related(doc: Pick<CollabFields, "parties"> & { _id: Types.ObjectId }, limit = 6) {
  const ids = doc.parties.map((p) => p.propertyId).filter(Boolean);
  if (!ids.length) return [];
  return Collab.find({ status: "published", _id: { $ne: doc._id }, "parties.propertyId": { $in: ids } })
    .sort({ "period.start": -1, _id: -1 })
    .limit(limit)
    .lean();
}

export async function revisions(id: string) {
  const doc = await getById(id);
  return Revision.find({ collabId: doc._id }).sort({ rev: -1, createdAt: -1 }).limit(200).lean();
}

/** Number of collabs in each status (admin queue tabs). */
export async function statusCounts() {
  const rows = await Collab.aggregate<{ _id: CollabStatus; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  return Object.fromEntries(COLLAB_STATUSES.map((s) => [s, rows.find((r) => r._id === s)?.n ?? 0])) as Record<CollabStatus, number>;
}

/** Duplicate candidates per collab, checked only for collabs still under review (0 otherwise). */
export async function duplicateCounts(docs: (Pick<CollabFields, "status" | "sources" | "parties" | "period"> & { _id: Types.ObjectId })[]) {
  return Promise.all(
    docs.map(async (d) =>
      d.status === "draft" || d.status === "in_review" ? (await findDuplicates(duplicateQueryFor(d))).length : 0,
    ),
  );
}

export async function duplicatesOf(id: string) {
  const doc = await getById(id);
  return findDuplicates(duplicateQueryFor(doc));
}
