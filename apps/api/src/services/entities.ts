import { Types, type ClientSession } from "mongoose";
import type { CompanyInput, CompanyPatch, PropertyInput, PropertyPatch } from "@gamecollabs/schema";
import { withTransaction } from "../db.js";
import { Collab, collabSearchTokens } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { Revision } from "../models/support.js";
import type { Principal } from "../auth/principal.js";
import { HttpError, badRequest, notFound } from "../lib/errors.js";
import { revalidate } from "../lib/outbound.js";
import { nameKey } from "../lib/text.js";
import { search } from "../search/provider.js";
import { recountEntities, snapshotName } from "./collabs.js";
import { taxonomy } from "./taxonomy.js";

export type EntityType = "property" | "company";
type EntityModel = typeof Property;

const modelOf = (type: EntityType) => (type === "property" ? Property : (Company as unknown as EntityModel));
const refPath = (type: EntityType) => (type === "property" ? "parties" : "companies");
const idField = (type: EntityType) => (type === "property" ? "propertyId" : "companyId");

async function assertKind(kind: string | undefined) {
  if (!kind) return;
  const problem = (await taxonomy()).problemWith(kind, "partner_category");
  if (problem) throw badRequest("invalid_kind", `${kind}: ${problem}`);
}

async function assertSlugFree(type: EntityType, slug: string, exceptId?: Types.ObjectId) {
  const clash = await modelOf(type).exists({ $or: [{ slug }, { formerSlugs: slug }], ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (clash) throw new HttpError(409, "duplicate_key", "slug already in use", { slug: ["already in use"] });
}

export async function createProperty(input: PropertyInput) {
  await assertKind(input.kind);
  await assertSlugFree("property", input.slug);
  if (input.parentId && !(await Property.exists({ _id: input.parentId }))) throw badRequest("invalid_parent", "parent not found");
  return Property.create({ ...input, parentId: input.parentId ?? null, officialUrl: input.officialUrl ?? null });
}

export async function createCompany(input: CompanyInput) {
  await assertSlugFree("company", input.slug);
  return Company.create({ ...input, country: input.country ?? null });
}

async function load(type: EntityType, id: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(id)) throw notFound(type);
  const doc = await modelOf(type).findById(id, null, { session });
  if (!doc) throw notFound(type);
  return doc;
}

/**
 * Re-snapshots name/slug in every collab that references the entity, in the
 * caller's transaction, and refreshes their search tokens.
 */
async function propagateSnapshot(type: EntityType, entity: { _id: Types.ObjectId; slug: string; name: Parameters<typeof snapshotName>[0] }, session: ClientSession) {
  const path = refPath(type);
  const field = idField(type);
  await Collab.updateMany(
    { [`${path}.${field}`]: entity._id },
    { $set: { [`${path}.$[e].name`]: snapshotName(entity.name), [`${path}.$[e].slug`]: entity.slug } },
    { arrayFilters: [{ [`e.${field}`]: entity._id }], session },
  );
  const affected = await Collab.find({ [`${path}.${field}`]: entity._id }, { i18n: 1, parties: 1, companies: 1, slug: 1, status: 1 }, { session }).lean();
  if (affected.length) {
    await Collab.bulkWrite(
      affected.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { searchTokens: collabSearchTokens(c) } } } })),
      { session },
    );
  }
  return affected.filter((c) => c.status === "published").map((c) => `collab:${c.slug}`);
}

export async function updateEntity(type: EntityType, id: string, patch: PropertyPatch | CompanyPatch) {
  if ("kind" in patch) await assertKind(patch.kind);
  const { doc, tags } = await withTransaction(async (session) => {
    const doc = await load(type, id, session);
    const oldSlug = doc.slug;
    if (patch.slug && patch.slug !== doc.slug) {
      await assertSlugFree(type, patch.slug, doc._id);
      doc.formerSlugs = [...new Set([...doc.formerSlugs, doc.slug])];
    }
    if ("parentId" in patch && patch.parentId) {
      if (patch.parentId === id) throw badRequest("invalid_parent", "an entity cannot be its own parent");
      if (!(await Property.exists({ _id: patch.parentId }).session(session))) throw badRequest("invalid_parent", "parent not found");
    }
    const renamed = (patch.name && JSON.stringify(patch.name) !== JSON.stringify(doc.name)) || (patch.slug && patch.slug !== doc.slug);
    doc.set(patch);
    await doc.save({ session });
    const tags = [`${type}:${oldSlug}`, `${type}:${doc.slug}`];
    if (renamed) tags.push("collabs", ...(await propagateSnapshot(type, doc, session)));
    if (type === "property" && "kind" in patch) {
      // Party kinds default to the property's kind; keep them in sync for linked parties.
      const toUpdate = await Collab.find({ "parties.propertyId": doc._id }, null, { session });
      for (const c of toUpdate) {
        c.parties.forEach((p) => {
          if (p.propertyId?.equals(doc._id)) p.kind = (doc as { kind?: string }).kind ?? p.kind;
        });
        await c.save({ session });
      }
    }
    return { doc, tags };
  });
  revalidate(tags);
  return doc;
}

/**
 * Merges `fromId` into `targetId`: references are re-pointed (each collab is
 * saved through the model so facets, tokens, rev and revisions stay right),
 * names and slugs of the absorbed entity become aliases and former slugs.
 */
export async function mergeEntities(type: EntityType, targetId: string, fromId: string, actor: Principal) {
  if (targetId === fromId) throw badRequest("invalid_merge", "cannot merge an entity into itself");
  const { target, tags } = await withTransaction(async (session) => {
    const target = await load(type, targetId, session);
    const from = await load(type, fromId, session);
    const path = refPath(type);
    const field = idField(type);
    const tags = new Set<string>([`${type}:${target.slug}`, `${type}:${from.slug}`, "collabs"]);

    const collabs = await Collab.find({ [`${path}.${field}`]: from._id }, null, { session });
    for (const c of collabs) {
      type Ref = { [k: string]: unknown; role: string };
      const refs = (c.toObject() as unknown as Record<string, Ref[]>)[path] ?? [];
      const isRef = (r: Ref, id: Types.ObjectId) => (r[field] as Types.ObjectId | null)?.equals(id) ?? false;
      const merged: Ref[] = [];
      for (const ref of refs) {
        const isFrom = isRef(ref, from._id);
        const next = isFrom ? { ...ref, [field]: target._id, slug: target.slug, name: snapshotName(target.name) } : ref;
        // Drop the absorbed reference when the collab already references the target in the same role.
        if (isFrom && refs.some((r) => isRef(r, target._id) && r.role === next.role)) continue;
        merged.push(next);
      }
      c.set(path, merged);
      await c.save({ session });
      await Revision.create(
        [{ collabId: c._id, rev: c.rev, actorId: actor.userId, actorLabel: actor.label, action: `merge:${type}`, diff: { from: from.slug, into: target.slug } }],
        { session },
      );
      if (c.status === "published") tags.add(`collab:${c.slug}`);
    }

    const absorbedNames = [from.name.ko, from.name.en, from.name.original, ...from.aliases].filter((n): n is string => !!n);
    const known = new Set([target.name.ko, target.name.en, target.name.original, ...target.aliases].filter(Boolean).map((n) => nameKey(n!)));
    target.aliases = [...target.aliases, ...absorbedNames.filter((n) => !known.has(nameKey(n)))];
    target.formerSlugs = [...new Set([...target.formerSlugs, from.slug, ...from.formerSlugs])];
    if (type === "property") await Property.updateMany({ parentId: from._id }, { parentId: target._id }, { session });
    await modelOf(type).deleteOne({ _id: from._id }, { session });
    await target.save({ session });
    await recountEntities(type === "property" ? [target._id] : [], type === "company" ? [target._id] : [], session);
    return { target, tags: [...tags] };
  });
  revalidate(tags);
  return target;
}

/** Exact name/alias matches first, then token (prefix / 2-gram) matches. */
export async function searchEntities(type: EntityType, q: string, limit = 10) {
  const model = modelOf(type);
  const key = nameKey(q);
  const exact = key ? await model.find({ nameKeys: key }).limit(limit).lean() : [];
  const tokenFilter = search.filter(q);
  const fuzzy = tokenFilter
    ? await model
        .find({ ...tokenFilter, _id: { $nin: exact.map((e) => e._id) } })
        .sort({ collabCount: -1 })
        .limit(limit - exact.length)
        .lean()
    : [];
  return [...exact.map((e) => ({ doc: e, exact: true })), ...fuzzy.map((e) => ({ doc: e, exact: false }))];
}

/** Every entity of a type, most used first (admin list without a query). */
export async function listEntities(type: EntityType, limit = 1000) {
  const docs = await modelOf(type).find().sort({ collabCount: -1, slug: 1 }).limit(limit).lean();
  return docs.map((doc) => ({ doc, exact: false }));
}

/** Lookup by slug or a former slug (callers redirect when `slug` differs from the request). */
export async function findBySlug(type: EntityType, slug: string) {
  const doc = await modelOf(type).findOne({ $or: [{ slug }, { formerSlugs: slug }] }).lean();
  if (!doc) throw notFound(type);
  return doc;
}

/** Published collabs of an entity (timeline) plus partner counts. */
export async function entityTimeline(type: EntityType, id: Types.ObjectId, limit = 500) {
  const path = refPath(type);
  const field = idField(type);
  const collabs = await Collab.find({ status: "published", [`${path}.${field}`]: id })
    .sort({ "period.start": -1, _id: -1 })
    .limit(limit)
    .lean();
  const partners = new Map<string, { id: string; slug: string | null; name: { ko: string | null; en: string | null }; kind: string | null; count: number }>();
  for (const c of collabs) {
    for (const p of c.parties) {
      if (!p.propertyId || (type === "property" && p.propertyId.equals(id))) continue;
      const k = p.propertyId.toString();
      const entry = partners.get(k) ?? { id: k, slug: p.slug ?? null, name: { ko: p.name?.ko ?? null, en: p.name?.en ?? null }, kind: p.kind ?? null, count: 0 };
      entry.count++;
      partners.set(k, entry);
    }
  }
  const starts = collabs.map((c) => c.period?.start).filter((d): d is Date => !!d);
  return {
    collabs,
    partners: [...partners.values()].sort((a, b) => b.count - a.count),
    firstStart: starts.length ? new Date(Math.min(...starts.map(Number))) : null,
    latestStart: starts.length ? new Date(Math.max(...starts.map(Number))) : null,
  };
}
