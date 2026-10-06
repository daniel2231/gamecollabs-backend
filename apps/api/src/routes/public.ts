import { once } from "node:events";
import { Router } from "express";
import { stringify } from "csv-stringify";
import { CollabListQuery, Locale, StatsQuery, type Locale as LocaleT } from "@gamecollabs/schema";
import { z } from "zod";
import { requireScope } from "../auth/principal.js";
import { parse } from "../lib/errors.js";
import { formatDate, phaseOf, type Precision } from "../lib/period.js";
import { Collab } from "../models/collab.js";
import { getPublishedBySlug, listPublic, publicFilter, related } from "../services/collabs.js";
import { entitySummary, collabCard, collabDetail, pick } from "../services/serialize.js";
import { entityTimeline, findBySlug, type EntityType } from "../services/entities.js";
import { stats } from "../services/stats.js";
import { taxonomy, taxonomyTree } from "../services/taxonomy.js";

const LocaleQuery = z.object({ locale: Locale.default("ko") });
const CSV_LIMIT = 10_000;

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

/** Current filter result as CSV (UTF-8 with BOM so Excel opens Korean correctly). */
publicRouter.get("/collabs/export.csv", async (req, res) => {
  const q = parse(CollabListQuery.omit({ cursor: true, limit: true }), req.query);
  const now = new Date();
  const tax = await taxonomy();
  const filter = await publicFilter(q, now);
  const labels = (keys: string[]) => keys.map((k) => tax.label(k, q.locale)).join("; ");
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="collabs-${now.toISOString().slice(0, 10)}.csv"`);
  res.write("﻿");
  const csv = stringify({
    header: true,
    columns: ["slug", "title", "phase", "start", "end", "end_kind", "category", "host", "partner", "partner_category", "region", "platform", "collab_type", "companies", "primary_source"],
  });
  csv.pipe(res);
  const cursor = Collab.find(filter).sort({ "period.start": q.sort === "start_asc" ? 1 : -1, _id: -1 }).limit(CSV_LIMIT).lean().cursor();
  for await (const d of cursor) {
    const precision = (d.period?.precision ?? "day") as Precision;
    const ok = csv.write({
      slug: d.slug,
      title: pick({ ko: d.i18n?.ko?.title, en: d.i18n?.en?.title }, q.locale),
      phase: phaseOf({ start: d.period?.start ?? null, until: d.period?.until ?? null, endKind: d.period?.endKind ?? "fixed" }, now),
      start: formatDate(d.period?.start, precision),
      end: formatDate(d.period?.end, precision),
      end_kind: d.period?.endKind,
      category: d.category ? tax.label(d.category, q.locale) : "",
      host: d.parties.filter((p) => p.role === "host").map((p) => pick(p.name, q.locale)).join("; "),
      partner: d.parties.filter((p) => p.role === "partner").map((p) => pick(p.name, q.locale)).join("; "),
      partner_category: labels(d.parties.filter((p) => p.role === "partner" && p.kind).map((p) => p.kind!)),
      region: labels(d.regions),
      platform: labels(d.platforms),
      collab_type: labels(d.collabTypes),
      companies: d.companies.map((c) => `${pick(c.name, q.locale)} (${c.role})`).join("; "),
      primary_source: d.sources.find((s) => s.isPrimary)?.url ?? d.sources[0]?.url ?? "",
    });
    if (!ok) await once(csv, "drain");
  }
  csv.end();
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
