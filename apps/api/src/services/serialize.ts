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

function cover(doc: LeanCollab, locale: Locale) {
  const c = doc.cover;
  if (!c || !(c.storageKey || c.originalUrl)) return null;
  return {
    url: mediaUrl(c.storageKey) ?? c.originalUrl,
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
    cover: cover(doc, locale),
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
    publishedAt: doc.review?.publishedAt?.toISOString() ?? null,
    updatedAt: doc.updatedAt?.toISOString() ?? null,
  };
}

/** Admin view: the stored document minus search tokens, plus the computed phase. */
export function collabAdmin(doc: LeanCollab, now = new Date()) {
  const { searchTokens: _omit, ...rest } = doc as LeanCollab & { searchTokens?: unknown };
  return {
    ...rest,
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
