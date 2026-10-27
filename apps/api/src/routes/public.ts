import { Router } from "express";
import { CollabListQuery, Locale, PropertyListQuery, StatsQuery, type Locale as LocaleT } from "@gamecollabs/schema";
import { z } from "zod";
import { requireScope } from "../auth/principal.js";
import { parse } from "../lib/errors.js";
import { formatDate } from "../lib/period.js";
import { getPublishedBySlug, listPublic, publicFilter, related } from "../services/collabs.js";
import { entitySummary, collabCard, collabDetail, pick, publicImage } from "../services/serialize.js";
import { entityTimeline, featuredProperties, findBySlug, type EntityType } from "../services/entities.js";
import { stats } from "../services/stats.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { taxonomy, taxonomyTree } from "../services/taxonomy.js";

const LocaleQuery = z.object({ locale: Locale.default("ko") });

export const publicRouter: Router = Router();
publicRouter.use(requireScope("public:read"));

publicRouter.get("/collabs", async (req, res) => {
  const q = parse(CollabListQuery, req.query);
  const now = new Date();
  const [tax, page] = await Promise.all([taxonomy(), listPublic(q, now)]);
  res.json({
    data: page.items.map((d) => collabCard(d, q.locale, tax, now)),
    meta: { total: page.total, nextCursor: page.nextCursor, locale: q.locale },
  });
});

publicRouter.get("/collabs/:slug", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  const now = new Date();
  const doc = await getPublishedBySlug(String(req.params.slug));
  const [tax, rel] = await Promise.all([taxonomy(), related(doc)]);
  res.json({ data: { ...collabDetail(doc, locale, tax, now), related: rel.map((r) => collabCard(r, locale, tax, now)) } });
});

async function entityPage(type: EntityType, slug: string, locale: LocaleT) {
  const now = new Date();
  const [tax, entity] = await Promise.all([taxonomy(), findBySlug(type, slug)]);
  const timeline = await entityTimeline(type, entity._id);
  return {
    ...entitySummary(entity, locale, tax),
    stats: {
      collabCount: timeline.collabs.length,
      firstStart: formatDate(timeline.firstStart),
      latestStart: formatDate(timeline.latestStart),
    },
    partners: timeline.partners.map((p) => ({ id: p.id, slug: p.slug, name: pick(p.name, locale), kind: tax.labeled(p.kind, locale), count: p.count })),
    collabs: timeline.collabs.map((c) => ({
      ...collabCard(c, locale, tax, now),
      // Role of this company in the collab (company pages only).
      ...(type === "company" ? { companyRole: c.companies.find((x) => x.companyId.equals(entity._id))?.role ?? "unspecified" } : {}),
    })),
  };
}

/** Home "browse by IP": properties the operators placed there, in their order (cached by the web under `featured` and `collabs`). */
publicRouter.get("/properties", async (req, res) => {
  const { locale } = parse(PropertyListQuery, req.query);
  const now = new Date();
  const [tax, rows] = await Promise.all([taxonomy(), featuredProperties(now)]);
  res.json({
    data: rows.map(({ property, collabCount, counterpartCount, ongoingCount, latestCover }) => ({
      slug: property.slug,
      name: pick(property.name, locale),
      names: { ko: property.name.ko ?? null, en: property.name.en ?? null, original: property.name.original ?? null },
      kind: tax.labeled(property.kind, locale),
      collabCount,
      counterpartCount,
      ongoingCount,
      image: publicImage(property.image, locale),
      latestCover: publicImage(latestCover, locale),
    })),
  });
});

publicRouter.get("/properties/:slug", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: await entityPage("property", String(req.params.slug), locale) });
});

publicRouter.get("/companies/:slug", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: await entityPage("company", String(req.params.slug), locale) });
});

/**
 * Published collabs and the entities that appear in them, for the web sitemap.
 * An entity page shows its collabs, so its `updatedAt` is the later of the entity's
 * own change and the newest change among its published collabs.
 */
publicRouter.get("/sitemap", async (_req, res) => {
  type Latest = { _id: unknown; at: Date };
  const latestBy = (array: "parties" | "companies", idField: "propertyId" | "companyId") =>
    Collab.aggregate<Latest>([
      { $match: { status: "published" } },
      { $unwind: `$${array}` },
      { $group: { _id: `$${array}.${idField}`, at: { $max: "$updatedAt" } } },
      { $match: { _id: { $ne: null } } },
    ]);
  const [collabs, propertyLatest, companyLatest] = await Promise.all([
    Collab.find({ status: "published" }).select({ slug: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
    latestBy("parties", "propertyId"),
    latestBy("companies", "companyId"),
  ]);
  const [properties, companies] = await Promise.all([
    Property.find({ _id: { $in: propertyLatest.map((l) => l._id) } }).select({ slug: 1, updatedAt: 1 }).sort({ slug: 1 }).lean(),
    Company.find({ _id: { $in: companyLatest.map((l) => l._id) } }).select({ slug: 1, updatedAt: 1 }).sort({ slug: 1 }).lean(),
  ]);
  const entry = (latest: Latest[]) => {
    const byId = new Map(latest.map((l) => [String(l._id), l.at]));
    return (e: { _id: unknown; slug: string; updatedAt?: Date | null }) => {
      const times = [e.updatedAt, byId.get(String(e._id))].filter((d): d is Date => d instanceof Date);
      const at = times.length ? new Date(Math.max(...times.map(Number))) : null;
      return { slug: e.slug, updatedAt: at?.toISOString() ?? null };
    };
  };
  res.json({
    data: {
      collabs: collabs.map((c) => ({ slug: c.slug, updatedAt: c.updatedAt?.toISOString() ?? null })),
      properties: properties.map(entry(propertyLatest)),
      companies: companies.map(entry(companyLatest)),
    },
  });
});

publicRouter.get("/taxonomies", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: taxonomyTree(await taxonomy(), locale) });
});

publicRouter.get("/stats", async (req, res) => {
  const q = parse(StatsQuery, req.query);
  const filter = await publicFilter(q);
  res.json({ data: await stats(filter, q.locale, await taxonomy(), new Date(), q.year) });
});
