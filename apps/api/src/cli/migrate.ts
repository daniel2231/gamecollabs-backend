import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import matter from "gray-matter";
import type { Taxonomy } from "@gamecollabs/schema";
import { withTransaction } from "../db.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { Revision } from "../models/support.js";
import { nameKey, slugify } from "../lib/text.js";
import { toStoredPeriod } from "../lib/period.js";
import { recount } from "../jobs/tasks.js";
import { snapshotName, toSources } from "../services/collabs.js";
import { taxonomy, type TaxonomyIndex } from "../services/taxonomy.js";

/**
 * Frontmatter field names of the MVP's `CollabItem`. Override with
 * `--fields fields.json` if the files use different names.
 */
export const DEFAULT_FIELDS = {
  id: "id",
  title: "title",
  titleEn: "title_en",
  game: "game_title",
  ip: "ip_title",
  companies: "companies",
  status: "status",
  category: "category",
  partnerCategory: "partner_category",
  region: "region",
  platform: "platform",
  collabType: "collab_type",
  start: "start_date",
  end: "end_date",
  summaryKo: "summary_ko",
  summaryEn: "summary_en",
  sourceUrl: "source_url",
  image: "image",
  imageCredit: "image_credit",
  tags: "tags",
} as const;

type Fields = Record<keyof typeof DEFAULT_FIELDS, string>;
/** `{ "platform": { "Offline Retail": null, "Mobile Game": "platform.mobile" } }`. `null` drops the value. */
type ValueMapping = Partial<Record<Taxonomy, Record<string, string | null>>>;
/** Raw entity name → canonical name, to merge spelling variants (`"PUBG M": "PUBG Mobile"`). */
type EntityMapping = Record<string, string>;

export type MigrateOptions = {
  dir: string;
  dryRun: boolean;
  allowUnmapped: boolean;
  fields?: Partial<Fields>;
  mapping?: ValueMapping;
  entityMap?: EntityMapping;
  reportPath?: string;
};

type Item = { file: string; data: Record<string, unknown> };

const arr = (v: unknown): string[] =>
  v == null || v === ""
    ? []
    : (Array.isArray(v) ? v : String(v).split(/[,;]/))
        .map((x) => String(x).trim())
        .filter(Boolean);

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v).trim());

function dateStr(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  return m ? (m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`) : null;
}

async function readItems(dir: string): Promise<Item[]> {
  const files = (await readdir(dir)).filter((f) => [".md", ".mdx"].includes(extname(f))).sort();
  return Promise.all(
    files.map(async (file) => ({ file, data: matter(await readFile(join(dir, file), "utf8")).data as Record<string, unknown> })),
  );
}

function mapper(tax: TaxonomyIndex, mapping: ValueMapping, unmapped: Map<string, number>) {
  return (taxonomyName: Taxonomy, values: string[]) => {
    const keys: string[] = [];
    for (const v of values) {
      const explicit = mapping[taxonomyName]?.[v];
      if (explicit === null) continue;
      const key = explicit ?? tax.map(taxonomyName, v);
      if (key) keys.push(key);
      else unmapped.set(`${taxonomyName}: ${v}`, (unmapped.get(`${taxonomyName}: ${v}`) ?? 0) + 1);
    }
    return [...new Set(keys)];
  };
}

/** Runs the whole migration. Re-runnable: everything is upserted by slug. */
export async function migrateMdx(opts: MigrateOptions) {
  const f: Fields = { ...DEFAULT_FIELDS, ...opts.fields };
  const items = await readItems(opts.dir);
  const tax = await taxonomy();
  const unmapped = new Map<string, number>();
  const map = mapper(tax, opts.mapping ?? {}, unmapped);
  const canonical = (name: string) => opts.entityMap?.[name] ?? name;

  // Pass 1: classification + entity candidates, without writing.
  type Plan = { item: Item; slug: string; game: string; ip: string; partnerKind: string | null; keys: Record<string, string[]> };
  const plans: Plan[] = [];
  const problems: string[] = [];
  const entityNames = new Map<string, { name: string; kind: string | null; variants: Set<string> }>();
  const companyNames = new Map<string, { name: string; variants: Set<string> }>();

  for (const item of items) {
    const d = item.data;
    const slug = str(d[f.id]) ?? basename(item.file, extname(item.file));
    const game = str(d[f.game]);
    const ip = str(d[f.ip]);
    if (!game || !ip) {
      problems.push(`${item.file}: missing ${!game ? f.game : f.ip}`);
      continue;
    }
    const [partnerKind = null] = map("partner_category", arr(d[f.partnerCategory]));
    const keys = {
      category: map("category", arr(d[f.category])),
      regions: map("region", arr(d[f.region])),
      platforms: map("platform", arr(d[f.platform])),
      collabTypes: map("collab_type", arr(d[f.collabType])),
    };
    plans.push({ item, slug, game: canonical(game), ip: canonical(ip), partnerKind, keys });
    for (const [raw, kind] of [
      [game, tax.map("partner_category", "game")],
      [ip, partnerKind],
    ] as const) {
      const name = canonical(raw);
      const e = entityNames.get(nameKey(name)) ?? { name, kind, variants: new Set<string>() };
      e.variants.add(raw);
      e.kind ??= kind;
      entityNames.set(nameKey(name), e);
    }
    for (const raw of arr(d[f.companies])) {
      const name = canonical(raw);
      const c = companyNames.get(nameKey(name)) ?? { name, variants: new Set<string>() };
      c.variants.add(raw);
      companyNames.set(nameKey(name), c);
    }
  }

  const report = {
    files: items.length,
    planned: plans.length,
    problems,
    unmapped: Object.fromEntries([...unmapped.entries()].sort()),
    entities: { properties: entityNames.size, companies: companyNames.size },
    written: 0,
    reconciliation: null as null | Record<string, unknown>,
  };
  if (opts.dryRun || (unmapped.size && !opts.allowUnmapped) || problems.length) {
    if (opts.reportPath) await writeFile(opts.reportPath, JSON.stringify(report, null, 2));
    return { ...report, aborted: !opts.dryRun };
  }

  // Pass 2: entities (upsert by slug), then collabs.
  const propertyIds = new Map<string, Awaited<ReturnType<typeof Property.findOne>>>();
  for (const [key, e] of entityNames) {
    const slug = slugify(e.name) || `property-${key.slice(0, 24)}`;
    let doc = await Property.findOne({ $or: [{ nameKeys: key }, { slug }] });
    if (!doc) {
      const hangul = /\p{Script=Hangul}/u.test(e.name);
      doc = new Property({ slug, kind: e.kind ?? "partner_category.other", name: hangul ? { ko: e.name } : { en: e.name, ko: e.name } });
    }
    doc.aliases = [...new Set([...doc.aliases, ...[...e.variants].filter((v) => v !== e.name)])];
    await doc.save();
    propertyIds.set(key, doc);
  }
  const companyIds = new Map<string, Awaited<ReturnType<typeof Company.findOne>>>();
  for (const [key, c] of companyNames) {
    const slug = slugify(c.name) || `company-${key.slice(0, 24)}`;
    let doc = await Company.findOne({ $or: [{ nameKeys: key }, { slug }] });
    if (!doc) doc = new Company({ slug, name: /\p{Script=Hangul}/u.test(c.name) ? { ko: c.name } : { en: c.name, ko: c.name } });
    doc.aliases = [...new Set([...doc.aliases, ...[...c.variants].filter((v) => v !== c.name)])];
    await doc.save();
    companyIds.set(key, doc);
  }

  for (const p of plans) {
    const d = p.item.data;
    const game = propertyIds.get(nameKey(p.game))!;
    const ip = propertyIds.get(nameKey(p.ip))!;
    const start = dateStr(d[f.start]);
    const end = dateStr(d[f.end]);
    const status = str(d[f.status]) === "archived" ? "archived" : "published";
    const sourceUrl = str(d[f.sourceUrl]);
    const title = str(d[f.title]) ?? `${p.game} × ${p.ip}`;
    const titleEn = str(d[f.titleEn]);
    const tags = arr(d[f.tags]);
    const fields = {
      status,
      i18n: {
        ko: { title, summary: str(d[f.summaryKo]), note: null },
        en: { title: titleEn, summary: str(d[f.summaryEn]), note: null, machineTranslated: false },
      },
      parties: [
        { propertyId: game!._id, slug: game!.slug, role: "host", kind: game!.kind, name: snapshotName(game!.name) },
        { propertyId: ip!._id, slug: ip!.slug, role: "partner", kind: p.partnerKind ?? ip!.kind, name: snapshotName(ip!.name) },
      ],
      companies: arr(d[f.companies]).map((raw) => {
        const c = companyIds.get(nameKey(canonical(raw)))!;
        return { companyId: c!._id, slug: c!.slug, role: "unspecified", name: snapshotName(c!.name) };
      }),
      category: p.keys.category![0] ?? null,
      regions: p.keys.regions,
      platforms: p.keys.platforms,
      collabTypes: p.keys.collabTypes,
      // The MVP cannot tell "permanent" from "undecided"; missing end dates become `tba` for review.
      period: toStoredPeriod({ start, end, endKind: end ? "fixed" : "tba" }),
      sources: sourceUrl ? toSources([{ url: sourceUrl, type: "press", isPrimary: true, title: null, publisher: null, accessedAt: null, archiveUrl: null }]) : [],
      cover: str(d[f.image]) ? { originalUrl: str(d[f.image]), storageKey: null, credit: str(d[f.imageCredit]), alt: { ko: title, en: titleEn } } : null,
      origin: { type: "migration", notes: tags.length ? `tags: ${tags.join(", ")}` : null },
    };
    if (!fields.sources.length) {
      problems.push(`${p.item.file}: no ${f.sourceUrl}, skipped`);
      continue;
    }
    await withTransaction(async (session) => {
      const existing = await Collab.findOne({ slug: p.slug }, null, { session });
      const doc = existing ?? new Collab({ slug: p.slug });
      doc.set(fields);
      if (status === "published" && !doc.review?.publishedAt) doc.set("review.publishedAt", fields.period.start ?? new Date());
      if (doc.isNew || doc.isModified()) {
        await doc.save({ session });
        await Revision.create([{ collabId: doc._id, rev: doc.rev, actorLabel: "migration", action: existing ? "migration:update" : "migration:create", diff: { file: p.item.file } }], { session });
      }
    });
    report.written++;
  }
  await recount();
  report.reconciliation = await reconcile(plans.map((p) => ({ slug: p.slug, start: dateStr(p.item.data[f.start]), end: dateStr(p.item.data[f.end]), keys: p.keys })));
  if (opts.reportPath) await writeFile(opts.reportPath, JSON.stringify(report, null, 2));
  return { ...report, aborted: false };
}

/** Compares the source files with what is stored: missing slugs, period and classification counts. */
async function reconcile(expected: { slug: string; start: string | null; end: string | null; keys: Record<string, string[]> }[]) {
  const docs = await Collab.find({ slug: { $in: expected.map((e) => e.slug) } }).lean();
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const missing = expected.filter((e) => !bySlug.has(e.slug)).map((e) => e.slug);
  const periodMismatch = expected
    .filter((e) => {
      const d = bySlug.get(e.slug);
      if (!d) return false;
      const s = d.period?.start?.toISOString().slice(0, e.start?.length ?? 10) ?? null;
      const en = d.period?.end?.toISOString().slice(0, e.end?.length ?? 10) ?? null;
      return s !== e.start || en !== e.end;
    })
    .map((e) => e.slug);
  const count = (list: string[][]) => list.flat().reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
  const expectedCounts = count(expected.flatMap((e) => Object.values(e.keys)));
  const storedCounts = count(docs.map((d) => [...(d.category ? [d.category] : []), ...d.regions, ...d.platforms, ...d.collabTypes]));
  const classificationMismatch = Object.keys({ ...expectedCounts, ...storedCounts }).filter((k) => expectedCounts[k] !== storedCounts[k]);
  return { expected: expected.length, stored: docs.length, missing, periodMismatch, classificationMismatch };
}
