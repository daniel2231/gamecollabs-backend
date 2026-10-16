import type { Locale } from "@gamecollabs/schema";
import type { CollabFields } from "../models/collab.js";
import { formatDate, phaseOf, type Precision } from "../lib/period.js";
import { mediaUrl } from "../lib/storage.js";
import type { TaxonomyIndex } from "./taxonomy.js";

type Lean<T> = T & { _id: { toString(): string } };
type LeanCollab = Lean<CollabFields> & { createdAt?: Date; updatedAt?: Date };

type Pair = { ko?: string | null; en?: string | null } | null | undefined;

/** Text in the requested language. Every collab and entity stores both, so there is no fallback. */
export function pick(pair: Pair, locale: Locale): string | null {
  return pair?.[locale] ?? null;
}

function localizedText(doc: LeanCollab, locale: Locale) {
  const text = doc.i18n?.[locale];
  return {
    title: text?.title ?? null,
    summary: text?.summary ?? null,
    note: text?.note ?? null,
  };
}

function period(doc: LeanCollab) {
  const p = doc.period;
  const precision = (p?.precision ?? "unknown") as Precision;
  return {
    start: formatDate(p?.start, precision),
    end: formatDate(p?.end, precision),
    precision,
    endKind: p?.endKind ?? "fixed",
  };
}

type StoredImage = {
  storageKey?: string | null;
  originalUrl?: string | null;
  credit?: string | null;
  alt?: Pair;
  width?: number | null;
  height?: number | null;
  mirrorError?: string | null;
} | null | undefined;

/** Public form of a collab cover or property image; null when there is no image. */
export function publicImage(c: StoredImage, locale: Locale) {
  if (!c || !(c.storageKey || c.originalUrl)) return null;
  return {
    url: mediaUrl(c.storageKey) ?? c.originalUrl,
    originalUrl: c.originalUrl ?? null,
    credit: c.credit ?? null,
    alt: pick(c.alt, locale),
    width: c.width ?? null,
    height: c.height ?? null,
  };
}

/** Compact item for lists, timelines and related collabs. */
export function collabCard(doc: LeanCollab, locale: Locale, tax: TaxonomyIndex, now = new Date()) {
  const text = localizedText(doc, locale);
  return {
    id: doc._id.toString(),
    slug: doc.slug,
    title: text.title,
    summary: text.summary,
    phase: phaseOf({ start: doc.period?.start ?? null, until: doc.period?.until ?? null, endKind: doc.period?.endKind ?? "fixed" }, now),
    period: period(doc),
    category: tax.labeled(doc.category, locale),
    parties: doc.parties.map((p) => ({
      id: p.propertyId?.toString() ?? null,
      slug: p.slug ?? null,
      role: p.role,
      name: pick(p.name, locale),
      kind: tax.labeled(p.kind, locale),
    })),
    regions: doc.regions.map((k) => tax.labeled(k, locale)!),
    platforms: doc.platforms.map((k) => tax.labeled(k, locale)!),
    collabTypes: doc.collabTypes.map((k) => tax.labeled(k, locale)!),
    cover: publicImage(doc.cover, locale),
    publishedAt: doc.review?.publishedAt?.toISOString() ?? null,
  };
}

/** Public detail. Internal fields (`review`, `rev`, `origin`, `searchTokens`) are never included. */
export function collabDetail(doc: LeanCollab, locale: Locale, tax: TaxonomyIndex, now = new Date()) {
  const text = localizedText(doc, locale);
  return {
    ...collabCard(doc, locale, tax, now),
    note: text.note,
    companies: doc.companies.map((c) => ({
      id: c.companyId.toString(),
      slug: c.slug ?? null,
      role: c.role,
      name: pick(c.name, locale),
    })),
    sources: doc.sources.map((s) => ({
      url: s.url,
      title: s.title ?? null,
      publisher: s.publisher ?? null,
      type: s.type,
      isPrimary: !!s.isPrimary,
      accessedAt: formatDate(s.accessedAt),
      lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    })),
    venues: (doc.venues ?? []).map((v) => ({ name: pick(v.name, locale), address: v.address ?? null, url: v.url ?? null })),
    updatedAt: doc.updatedAt?.toISOString() ?? null,
  };
}

/** Admin form of a collab cover or property image, with its public URL. */
function adminImage(c: StoredImage) {
  if (!c || !(c.storageKey || c.originalUrl)) return null;
  return {
    storageKey: c.storageKey ?? null,
    url: mediaUrl(c.storageKey) ?? c.originalUrl ?? null,
    originalUrl: c.originalUrl ?? null,
    credit: c.credit ?? null,
    alt: c.alt?.ko && c.alt?.en ? { ko: c.alt.ko, en: c.alt.en } : null,
    width: c.width ?? null,
    height: c.height ?? null,
  };
}

/** Admin view: the stored document minus search tokens, plus the computed phase and the cover's public URL. */
export function collabAdmin(doc: LeanCollab, now = new Date()) {
  const { searchTokens: _omit, ...rest } = doc as LeanCollab & { searchTokens?: unknown };
  const cover = adminImage(doc.cover);
  return {
    ...rest,
    cover: cover ? { ...cover, mirrorError: doc.cover?.mirrorError ?? null } : null,
    id: doc._id.toString(),
    phase: phaseOf({ start: doc.period?.start ?? null, until: doc.period?.until ?? null, endKind: doc.period?.endKind ?? "fixed" }, now),
  };
}

type LeanEntity = Lean<{
  slug: string;
  name: { ko?: string | null; en?: string | null; original?: string | null };
  aliases: string[];
  collabCount: number;
  kind?: string;
  country?: string | null;
  officialUrl?: string | null;
}>;

export function entitySummary(doc: LeanEntity, locale: Locale, tax: TaxonomyIndex) {
  return {
    id: doc._id.toString(),
    slug: doc.slug,
    name: pick(doc.name, locale),
    names: { ko: doc.name.ko ?? null, en: doc.name.en ?? null, original: doc.name.original ?? null },
    ...(doc.kind !== undefined ? { kind: tax.labeled(doc.kind, locale) } : {}),
    ...(doc.country !== undefined ? { country: doc.country ?? null } : {}),
    ...(doc.officialUrl !== undefined ? { officialUrl: doc.officialUrl ?? null } : {}),
    aliases: doc.aliases,
    collabCount: doc.collabCount,
  };
}

type PropertyExtras = { featuredOrder?: number | null; image?: StoredImage };

/** Home placement fields of a property in the admin form (lists, search, create/update/merge). */
export function propertyAdminFields(doc: PropertyExtras) {
  return { featuredOrder: doc.featuredOrder ?? null, image: adminImage(doc.image) };
}
