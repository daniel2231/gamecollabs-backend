import type { Locale, Taxonomy, TaxonomyTermInput, TaxonomyTermPatch } from "@gamecollabs/schema";
import { TaxonomyTerm } from "../models/taxonomyTerm.js";
import { HttpError, badRequest, notFound } from "../lib/errors.js";
import { nameKey } from "../lib/text.js";

export type Term = {
  _id: string;
  taxonomy: Taxonomy;
  parent: string | null;
  ancestors: string[];
  label: { ko: string; en: string };
  order: number;
  deprecated: boolean;
  legacyValues: string[];
};

export class TaxonomyIndex {
  readonly byKey = new Map<string, Term>();
  /** `<taxonomy>:<nameKey>` → key, from legacy values, labels and the key's last segment. */
  private readonly lookup = new Map<string, string>();

  constructor(terms: Term[]) {
    for (const term of terms) this.byKey.set(term._id, term);
    for (const term of terms) {
      if (term.deprecated) continue;
      const names = [term._id, term._id.split(".")[1]!, term.label.ko, term.label.en, ...term.legacyValues];
      for (const name of names) {
        const k = `${term.taxonomy}:${nameKey(name)}`;
        if (!this.lookup.has(k)) this.lookup.set(k, term._id);
      }
    }
  }

  problemWith(key: string, taxonomy: Taxonomy, { allowDeprecated = false } = {}): string | null {
    const term = this.byKey.get(key);
    if (!term) return "unknown taxonomy key";
    if (term.taxonomy !== taxonomy) return `expected a ${taxonomy} key`;
    if (term.deprecated && !allowDeprecated) return "taxonomy key is deprecated";
    return null;
  }

  /** Keys plus all their ancestors, de-duplicated, in input order. */
  expand(keys: string[]): string[] {
    const out = new Set<string>();
    for (const key of keys) {
      out.add(key);
      for (const ancestor of this.byKey.get(key)?.ancestors ?? []) out.add(ancestor);
    }
    return [...out];
  }

  label(key: string, locale: Locale): string {
    const term = this.byKey.get(key);
    return term ? term.label[locale] || term.label.ko : key;
  }

  labeled(key: string | null | undefined, locale: Locale) {
    return key ? { key, label: this.label(key, locale) } : null;
  }

  /** Maps a free-form value (`Android`, `South Korea`, `platform.android`) to a key, or null. */
  map(taxonomy: Taxonomy, value: string): string | null {
    const direct = this.byKey.get(value);
    if (direct && direct.taxonomy === taxonomy && !direct.deprecated) return direct._id;
    return this.lookup.get(`${taxonomy}:${nameKey(value)}`) ?? null;
  }

  terms(taxonomy?: Taxonomy, { includeDeprecated = false } = {}): Term[] {
    return [...this.byKey.values()]
      .filter((t) => (!taxonomy || t.taxonomy === taxonomy) && (includeDeprecated || !t.deprecated))
      .sort((a, b) => a.order - b.order || a._id.localeCompare(b._id));
  }
}

const TTL_MS = 30_000;
let cache: { index: TaxonomyIndex; at: number } | null = null;
let loading: Promise<TaxonomyIndex> | null = null;

/** Cached taxonomy index (30s TTL, invalidated locally on writes). */
export async function taxonomy(): Promise<TaxonomyIndex> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.index;
  loading ??= TaxonomyTerm.find()
    .lean<Term[]>()
    .then((terms) => {
      const index = new TaxonomyIndex(terms);
      cache = { index, at: Date.now() };
      return index;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function invalidateTaxonomy(): void {
  cache = null;
}

async function ancestorsOf(parent: string | null | undefined, taxonomyName: Taxonomy, selfKey: string): Promise<string[]> {
  if (!parent) return [];
  const parentTerm = await TaxonomyTerm.findById(parent).lean<Term>();
  if (!parentTerm) throw badRequest("invalid_parent", `parent ${parent} does not exist`);
  if (parentTerm.taxonomy !== taxonomyName) throw badRequest("invalid_parent", "parent must be in the same taxonomy");
  if (parent === selfKey || parentTerm.ancestors.includes(selfKey)) throw badRequest("invalid_parent", "cycle");
  return [...parentTerm.ancestors, parent];
}

export async function createTerm(input: TaxonomyTermInput): Promise<Term> {
  const taxonomyName = input.key.split(".")[0] as Taxonomy;
  const ancestors = await ancestorsOf(input.parent, taxonomyName, input.key);
  if (await TaxonomyTerm.exists({ _id: input.key })) throw new HttpError(409, "duplicate_key", `${input.key} exists`);
  const term = await TaxonomyTerm.create({
    _id: input.key,
    taxonomy: taxonomyName,
    parent: input.parent ?? null,
    ancestors,
    label: input.label,
    order: input.order,
    legacyValues: input.legacyValues,
  });
  invalidateTaxonomy();
  return term.toObject() as unknown as Term;
}

/**
 * Updates a term. Changing the parent rewrites the ancestors of the whole
 * subtree; existing collabs pick up new facet keys via the `reindex-facets` job.
 */
export async function updateTerm(key: string, patch: TaxonomyTermPatch): Promise<{ term: Term; parentChanged: boolean }> {
  const term = await TaxonomyTerm.findById(key);
  if (!term) throw notFound("taxonomy term");
  let parentChanged = false;
  if (patch.parent !== undefined && patch.parent !== term.parent) {
    term.ancestors = await ancestorsOf(patch.parent, term.taxonomy as Taxonomy, key);
    term.parent = patch.parent;
    parentChanged = true;
  }
  if (patch.label) term.label = patch.label;
  if (patch.order !== undefined) term.order = patch.order;
  if (patch.deprecated !== undefined) term.deprecated = patch.deprecated;
  if (patch.legacyValues) term.legacyValues = patch.legacyValues;
  await term.save();
  if (parentChanged) {
    const descendants = await TaxonomyTerm.find({ ancestors: key });
    for (const d of descendants) {
      const idx = d.ancestors.indexOf(key);
      d.ancestors = [...term.ancestors, ...d.ancestors.slice(idx)];
      await d.save();
    }
  }
  invalidateTaxonomy();
  return { term: term.toObject() as unknown as Term, parentChanged };
}

export function taxonomyTree(index: TaxonomyIndex, locale: Locale) {
  const out: Record<string, unknown[]> = {};
  for (const tax of ["category", "partner_category", "region", "platform", "collab_type"] as const) {
    const terms = index.terms(tax);
    const node = (t: Term): unknown => ({
      key: t._id,
      label: t.label[locale] || t.label.ko,
      labels: t.label,
      children: terms.filter((c) => c.parent === t._id).map(node),
    });
    out[tax] = terms.filter((t) => !t.parent || !index.byKey.has(t.parent)).map(node);
  }
  return out;
}
