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
  /** Korean title. Built from the Korean names when both titles are missing. */
  title: "title",
  titleEn: "title_en",
  /** English name of the game; the Korean name comes from `gameKo`. */
  game: "game_title",
  gameKo: "game_title_ko",
  ip: "ip_title",
  ipKo: "ip_title_ko",
  /** English company names, with Korean names at the same positions in `companiesKo`. */
  companies: "companies",
  companiesKo: "companies_ko",
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
  /** Editor remark; kept as an internal note (not shown publicly). */
  note: "note",
} as const;

type Fields = Record<keyof typeof DEFAULT_FIELDS, string>;
/**
 * `{ "platform": { "Offline Retail": null, "PC / Console": ["platform.pc", "platform.console"] } }`.
 * A key, several keys, or `null` to drop the value.
 */
type ValueMapping = Partial<Record<Taxonomy, Record<string, string | string[] | null>>>;
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
  /**
   * Origin of the old blog (`https://blog.example.com`). MVP images uploaded
   * through Decap CMS are stored as site paths (`/blog/uploads/x.jpg`) and are
   * resolved against it so the cover mirror job can download them.
   */
  imageBaseUrl?: string;
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
    const miss = (label: string) => unmapped.set(label, (unmapped.get(label) ?? 0) + 1);
    for (const v of values) {
      const explicit = mapping[taxonomyName]?.[v];
      if (explicit === null) continue;
      if (explicit !== undefined) {
        // Keys named in the mapping file must exist in that taxonomy.
        for (const key of [explicit].flat()) {
          if (tax.problemWith(key, taxonomyName)) miss(`${taxonomyName}: ${v} → ${key} (key not in taxonomy)`);
          else keys.push(key);
        }
        continue;
      }
      const key = tax.map(taxonomyName, v);
      if (key) keys.push(key);
      else miss(`${taxonomyName}: ${v}`);
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
  /** Absolute image URL, or `{ error }` for a site path when no base URL was given. */
  const imageUrl = (raw: string | null): { url: string | null } | { error: string } => {
    if (!raw) return { url: null };
    if (/^https?:\/\//i.test(raw)) return { url: raw };
    if (!opts.imageBaseUrl) return { error: `image "${raw}" is a path on the old blog; pass --image-base-url https://<blog domain>` };
    return { url: new URL(raw, opts.imageBaseUrl).toString() };
  };

  // Pass 1: classification + entity candidates, without writing.
  // Every title, summary and name must exist in Korean and English; anything missing is a problem.
  type Names = { en: string; ko: string };
  type Plan = {
    item: Item;
    slug: string;
    game: Names;
    ip: Names;
    companies: Names[];
    partnerKind: string | null;
    keys: Record<string, string[]>;
    /** Imported as a draft because the publish rules would refuse it. */
    draft: boolean;
  };
  const plans: Plan[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const entityNames = new Map<string, Names & { kind: string | null; variants: Set<string> }>();
  const companyNames = new Map<string, Names & { variants: Set<string> }>();

  for (const item of items) {
    const d = item.data;
    const slug = str(d[f.id]) ?? basename(item.file, extname(item.file));
    const missing = (field: string) => problems.push(`${item.file}: missing ${field}`);
    const gameEn = str(d[f.game]);
    const gameKo = str(d[f.gameKo]);
    const ipEn = str(d[f.ip]);
    const ipKo = str(d[f.ipKo]);
    const companiesEn = arr(d[f.companies]);
    const companiesKo = arr(d[f.companiesKo]);
    const before = problems.length;
    if (!gameEn) missing(f.game);
    if (!gameKo) missing(f.gameKo);
    if (!ipEn) missing(f.ip);
    if (!ipKo) missing(f.ipKo);
    if (companiesEn.length !== companiesKo.length) problems.push(`${item.file}: ${f.companies} and ${f.companiesKo} must list the same companies`);
    const image = imageUrl(str(d[f.image]));
    if ("error" in image) problems.push(`${item.file}: ${image.error}`);
    if (!str(d[f.summaryKo])) missing(f.summaryKo);
    if (!str(d[f.summaryEn])) missing(f.summaryEn);
    if (!str(d[f.title]) !== !str(d[f.titleEn])) missing(str(d[f.title]) ? f.titleEn : f.title);
    if (problems.length > before) continue;

    const partnerKinds = map("partner_category", arr(d[f.partnerCategory]));
    const partnerKind = partnerKinds[0] ?? null;
    if (partnerKinds.length > 1) warnings.push(`${item.file}: several ${f.partnerCategory} values, using ${partnerKind} (dropped ${partnerKinds.slice(1).join(", ")})`);
    const keys = {
      category: map("category", arr(d[f.category])),
      regions: map("region", arr(d[f.region])),
      platforms: map("platform", arr(d[f.platform])),
      collabTypes: map("collab_type", arr(d[f.collabType])),
    };
    const game = { en: canonical(gameEn!), ko: gameKo! };
    const ip = { en: canonical(ipEn!), ko: ipKo! };
    const companies = companiesEn.map((en, i) => ({ en: canonical(en), ko: companiesKo[i]! }));
    // Anything the publish rules would refuse comes in as a draft for the editor to finish.
    const missingForPublish = [!dateStr(d[f.start]) && f.start, !keys.category[0] && f.category].filter(Boolean);
    const draft = str(d[f.status]) !== "archived" && missingForPublish.length > 0;
    if (draft) warnings.push(`${item.file}: will be imported as draft (missing ${missingForPublish.join(", ")})`);
    plans.push({ item, slug, game, ip, companies, partnerKind, keys, draft });
    for (const [names, raw, kind] of [
      [game, gameEn!, tax.map("partner_category", "game")],
      [ip, ipEn!, partnerKind],
    ] as const) {
      const e = entityNames.get(nameKey(names.en)) ?? { ...names, kind, variants: new Set<string>() };
      e.variants.add(raw);
      e.kind ??= kind;
      entityNames.set(nameKey(names.en), e);
    }
    companiesEn.forEach((raw, i) => {
      const names = companies[i]!;
      const c = companyNames.get(nameKey(names.en)) ?? { ...names, variants: new Set<string>() };
      c.variants.add(raw);
      companyNames.set(nameKey(names.en), c);
    });
  }

  const report = {
    files: items.length,
    planned: plans.length,
    problems,
    warnings,
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
  const isName = (v: string, n: Names) => v === n.en || v === n.ko;
  for (const [key, e] of entityNames) {
    const slug = slugify(e.en) || `property-${key.slice(0, 24)}`;
    let doc = await Property.findOne({ $or: [{ nameKeys: key }, { slug }] });
    doc ??= new Property({ slug, kind: e.kind ?? "partner_category.other", name: { ko: e.ko, en: e.en } });
    doc.aliases = [...new Set([...doc.aliases, ...[...e.variants].filter((v) => !isName(v, e))])];
    await doc.save();
    propertyIds.set(key, doc);
  }
  const companyIds = new Map<string, Awaited<ReturnType<typeof Company.findOne>>>();
  for (const [key, c] of companyNames) {
    const slug = slugify(c.en) || `company-${key.slice(0, 24)}`;
    let doc = await Company.findOne({ $or: [{ nameKeys: key }, { slug }] });
    doc ??= new Company({ slug, name: { ko: c.ko, en: c.en } });
    doc.aliases = [...new Set([...doc.aliases, ...[...c.variants].filter((v) => !isName(v, c))])];
    await doc.save();
    companyIds.set(key, doc);
  }

  for (const p of plans) {
    const d = p.item.data;
    const game = propertyIds.get(nameKey(p.game.en))!;
    const ip = propertyIds.get(nameKey(p.ip.en))!;
    const start = dateStr(d[f.start]);
    const end = dateStr(d[f.end]);
    const category = p.keys.category![0] ?? null;
    const status = str(d[f.status]) === "archived" ? "archived" : p.draft ? "draft" : "published";
    const sourceUrl = str(d[f.sourceUrl]);
    const title = str(d[f.title]) ?? `${p.game.ko} × ${p.ip.ko}`;
    const titleEn = str(d[f.titleEn]) ?? `${p.game.en} x ${p.ip.en}`;
    const tags = arr(d[f.tags]);
    const notes = [str(d[f.note]), tags.length ? `tags: ${tags.join(", ")}` : null].filter(Boolean).join("\n");
    const fields = {
      status,
      i18n: {
        ko: { title, summary: str(d[f.summaryKo])!, note: null },
        en: { title: titleEn, summary: str(d[f.summaryEn])!, note: null },
      },
      parties: [
        { propertyId: game!._id, slug: game!.slug, role: "host", kind: game!.kind, name: snapshotName(game!.name) },
        { propertyId: ip!._id, slug: ip!.slug, role: "partner", kind: p.partnerKind ?? ip!.kind, name: snapshotName(ip!.name) },
      ],
      companies: p.companies.map((names) => {
        const c = companyIds.get(nameKey(names.en))!;
        return { companyId: c!._id, slug: c!.slug, role: "unspecified", name: snapshotName(c!.name) };
      }),
      category,
      regions: p.keys.regions,
      platforms: p.keys.platforms,
      collabTypes: p.keys.collabTypes,
      // The MVP cannot tell "permanent" from "undecided"; missing end dates become `tba` for review.
      period: toStoredPeriod({ start, end, endKind: end ? "fixed" : "tba" }),
      sources: sourceUrl ? toSources([{ url: sourceUrl, type: "press", isPrimary: true, title: null, publisher: null, accessedAt: null, archiveUrl: null }]) : [],
      cover: null as null | Record<string, unknown>,
      origin: { type: "migration", notes: notes || null },
    };
    if (!fields.sources.length) {
      problems.push(`${p.item.file}: no ${f.sourceUrl}, skipped`);
      continue;
    }
    await withTransaction(async (session) => {
      const existing = await Collab.findOne({ slug: p.slug }, null, { session });
      const doc = existing ?? new Collab({ slug: p.slug });
      const image = imageUrl(str(d[f.image]));
      const originalUrl = "url" in image ? image.url : null;
      if (originalUrl) {
        // Keep the mirrored copy when the image did not change, so re-runs do not re-upload it.
        const kept = existing?.cover?.originalUrl === originalUrl ? existing.cover : null;
        fields.cover = {
          originalUrl,
          storageKey: kept?.storageKey ?? null,
          width: kept?.width ?? null,
          height: kept?.height ?? null,
          credit: str(d[f.imageCredit]),
          alt: { ko: title, en: titleEn },
        };
      }
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
