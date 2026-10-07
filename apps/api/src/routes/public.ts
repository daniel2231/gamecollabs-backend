import { Router } from "express";
import { CollabListQuery, Locale, StatsQuery, type Locale as LocaleT } from "@gamecollabs/schema";
import { z } from "zod";
import { requireScope } from "../auth/principal.js";
import { parse } from "../lib/errors.js";
import { formatDate } from "../lib/period.js";
import { getPublishedBySlug, listPublic, publicFilter, related } from "../services/collabs.js";
import { entitySummary, collabCard, collabDetail, pick } from "../services/serialize.js";
import { entityTimeline, findBySlug, type EntityType } from "../services/entities.js";
import { stats } from "../services/stats.js";
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
    collabs: timeline.collabs.map((c) => collabCard(c, locale, tax, now)),
  };
}

publicRouter.get("/properties/:slug", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: await entityPage("property", String(req.params.slug), locale) });
});

publicRouter.get("/companies/:slug", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: await entityPage("company", String(req.params.slug), locale) });
});

publicRouter.get("/taxonomies", async (req, res) => {
  const { locale } = parse(LocaleQuery, req.query);
  res.json({ data: taxonomyTree(await taxonomy(), locale) });
});

publicRouter.get("/stats", async (req, res) => {
  const q = parse(StatsQuery, req.query);
  const filter = await publicFilter(q);
  res.json({ data: await stats(filter, q.locale, await taxonomy()) });
});
