import { Types } from "mongoose";
import {
  IngestCandidate,
  zodFieldErrors,
  type CollabInput,
  type IngestItemResult,
  type IngestRequest,
  type IngestResponse,
} from "@gamecollabs/schema";
import { config } from "../config.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { IngestRun } from "../models/support.js";
import type { Principal } from "../auth/principal.js";
import { notify } from "../lib/outbound.js";
import { parseDateInput } from "../lib/period.js";
import { checkUrl, isReachable } from "../lib/safeFetch.js";
import { nameKey } from "../lib/text.js";
import { normalizeUrl } from "../lib/url.js";
import { search } from "../search/provider.js";
import { createDraft, findDuplicates } from "./collabs.js";
import { mirrorCover } from "./media.js";
import { taxonomy, type TaxonomyIndex } from "./taxonomy.js";
import { logger } from "../logger.js";

const KST_OFFSET_MS = 9 * 3_600_000;

/** Start of the current day in Korea (the operator's day), as a UTC instant. */
export function startOfKstDay(now = new Date()): Date {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - KST_OFFSET_MS);
}

async function createdToday(now = new Date()): Promise<number> {
  return Collab.countDocuments({ "origin.runId": { $ne: null }, createdAt: { $gte: startOfKstDay(now) } });
}

async function findEntity(model: typeof Property | typeof Company, name: string, slug?: string | null) {
  const m = model as typeof Property;
  if (slug) {
    const bySlug = await m.findOne({ $or: [{ slug }, { formerSlugs: slug }] }).lean();
    if (bySlug) return bySlug;
  }
  const key = nameKey(name);
  if (!key) return null;
  const matches = await m.find({ nameKeys: key }).limit(2).lean();
  // Ambiguous exact matches are left for the reviewer.
  return matches.length === 1 ? matches[0]! : null;
}

type Unmapped = Record<string, string[]>;

function mapValues(tax: TaxonomyIndex, field: "region" | "platform" | "collab_type", values: string[], unmapped: Unmapped) {
  const keys: string[] = [];
  for (const v of values) {
    const key = tax.map(field, v);
    if (key) keys.push(key);
    else (unmapped[field] ??= []).push(v);
  }
  return [...new Set(keys)];
}

const reason = (code: string, message: string) => ({ code, message });

type Context = { runId: string; client: string; model?: string; actor: Principal; tax: TaxonomyIndex };

async function processCandidate(raw: unknown, index: number, ctx: Context): Promise<IngestItemResult> {
  const parsed = IngestCandidate.safeParse(raw);
  if (!parsed.success) {
    const fields = zodFieldErrors(parsed.error);
    return {
      index,
      status: "rejected",
      reasons: Object.entries(fields).map(([path, msgs]) => reason("invalid", `${path}: ${msgs.join(", ")}`)),
    };
  }
  const c = parsed.data;
  const warnings: string[] = [];
  const unmapped: Unmapped = {};

  // 1. Sources: normalized, de-duplicated.
  let sourceUrls = [...new Set(c.sources.map((s) => normalizeUrl(s.url)))];

  // 2. Entities.
  const game = await findEntity(Property, c.game.name, c.game.slug);
  const partner = await findEntity(Property, c.partner.name, c.partner.slug);
  if (!game) warnings.push(`game "${c.game.name}" is not linked to a property yet`);
  if (!partner) warnings.push(`partner "${c.partner.name}" is not linked to a property yet`);

  // 3. Duplicates (server decides; the client's own check is not trusted).
  let start: Date | null = null;
  try {
    if (c.period.start) start = parseDateInput(c.period.start);
  } catch {
    return { index, status: "rejected", reasons: [reason("invalid", "period.start: invalid date")] };
  }
  if (!start) warnings.push("start date not announced; the draft cannot be published until it is set");
  const dupes = await findDuplicates({
    sourceUrls,
    hostIds: game ? [game._id] : [],
    partnerIds: partner ? [partner._id] : [],
    start,
  });
  if (dupes.length) {
    const d = dupes[0]!;
    return { index, status: "duplicate", id: d.id, slug: d.slug, reasons: [reason(d.reason, `matches ${d.slug} (${d.status})`)] };
  }

  // 4. Source reachability.
  if (config().INGEST_VERIFY_SOURCES) {
    const checks = await Promise.all(sourceUrls.map((u) => checkUrl(u)));
    const reachable = sourceUrls.filter((_, i) => isReachable(checks[i]!.status));
    if (!reachable.length) {
      const detail = checks.map((r, i) => `${sourceUrls[i]} → ${r.status ?? r.error}`).join("; ");
      return { index, status: "rejected", reasons: [reason("source_unreachable", detail)] };
    }
    for (const [i, u] of sourceUrls.entries()) if (!isReachable(checks[i]!.status)) warnings.push(`dropped unreachable source ${u}`);
    sourceUrls = reachable;
  }

  // 5. Classification: map free text to keys, keep what fails.
  const { tax } = ctx;
  let category: string | null = null;
  if (c.category) {
    category = tax.map("category", c.category);
    if (!category) unmapped.category = [c.category];
  }
  const regions = mapValues(tax, "region", c.regions, unmapped);
  const platforms = mapValues(tax, "platform", c.platforms, unmapped);
  const collabTypes = mapValues(tax, "collab_type", c.collabTypes, unmapped);
  let partnerKind = c.partner.kind ? tax.map("partner_category", c.partner.kind) : null;
  if (c.partner.kind && !partnerKind) unmapped.partner_category = [c.partner.kind];
  partnerKind ??= partner?.kind ?? null;
  const gameKind = game?.kind ?? tax.map("partner_category", "game");

  const companies: CollabInput["companies"] = [];
  for (const co of c.companies) {
    const company = await findEntity(Company, co.name);
    if (company) companies.push({ companyId: company._id.toString(), role: co.role });
    else (unmapped.companies ??= []).push(`${co.name} (${co.role})`);
  }

  const bySourceUrl = new Map(c.sources.map((s) => [normalizeUrl(s.url), s]));
  const today = new Date().toISOString().slice(0, 10);
  const input: CollabInput = {
    i18n: {
      ko: { title: c.title.ko ?? null, summary: c.summary.ko ?? null },
      en: { title: c.title.en ?? null, summary: c.summary.en ?? null },
    },
    parties: [
      { propertyId: game?._id.toString() ?? null, role: "host", kind: gameKind, name: game ? null : { ko: c.game.name, en: c.game.name } },
      { propertyId: partner?._id.toString() ?? null, role: "partner", kind: partnerKind, name: partner ? null : { ko: c.partner.name, en: c.partner.name } },
    ],
    companies,
    category,
    regions,
    platforms,
    collabTypes,
    period: { start: c.period.start ?? null, end: c.period.end ?? null, endKind: c.period.end ? "fixed" : c.period.endKind },
    sources: sourceUrls.map((url, i) => {
      const s = bySourceUrl.get(url);
      return { url, title: s?.title ?? null, publisher: s?.publisher ?? null, type: s?.type ?? "press", isPrimary: i === 0, accessedAt: today };
    }),
    cover: c.coverImageUrl ? { originalUrl: c.coverImageUrl } : null,
  };

  const isGpt = /gpt|openai/i.test(ctx.client);
  const { doc } = await createDraft(input, ctx.actor, {
    origin: {
      type: isGpt ? "gpt" : "agent",
      runId: ctx.runId,
      client: ctx.client,
      model: ctx.model ?? null,
      confidence: c.confidence ?? null,
      unmapped: Object.keys(unmapped).length ? unmapped : null,
      notes: c.notes ?? null,
    },
  });
  if (doc.cover?.originalUrl) void mirrorCover(doc).catch(() => undefined);
  return {
    index,
    status: "created",
    id: doc._id.toString(),
    slug: doc.slug,
    ...(warnings.length ? { warnings } : {}),
    ...(Object.keys(unmapped).length ? { unmapped } : {}),
  };
}

/**
 * The single ingest entry point: used by `POST /v1/ingest/candidates` (MCP
 * server, agents) and by the OpenAI fallback scheduler. Every accepted
 * candidate becomes a `draft`; nothing is ever published here.
 */
export async function ingestCandidates(req: IngestRequest, actor: Principal, channel = "candidates"): Promise<IngestResponse> {
  const runId = req.runId ?? `${req.client}-${new Types.ObjectId().toString()}`;
  const ctx: Context = { runId, client: req.client, model: req.model, actor, tax: await taxonomy() };
  const limit = config().INGEST_DAILY_LIMIT;
  let remaining = limit - (await createdToday());
  const results: IngestItemResult[] = [];
  let limitHit = false;

  for (const [index, raw] of req.candidates.entries()) {
    if (remaining <= 0) {
      limitHit = true;
      results.push({ index, status: "rejected", reasons: [reason("daily_limit", `daily limit of ${limit} drafts reached`)] });
      continue;
    }
    try {
      const result = await processCandidate(raw, index, ctx);
      if (result.status === "created") remaining--;
      results.push(result);
    } catch (err) {
      logger.error({ err, runId, index }, "ingest candidate failed");
      results.push({ index, status: "rejected", reasons: [reason("internal_error", "candidate could not be stored")] });
    }
  }

  const summary = { created: 0, duplicate: 0, rejected: 0 };
  for (const r of results) summary[r.status]++;
  await IngestRun.updateOne(
    { runId },
    {
      $setOnInsert: { runId, channel, client: req.client, actorId: actor.userId },
      $set: { lastCallAt: new Date(), ...(req.model ? { model: req.model } : {}) },
      $inc: { calls: 1, "counts.created": summary.created, "counts.duplicate": summary.duplicate, "counts.rejected": summary.rejected },
      $push: { items: { $each: results.map((r) => ({ ...r, at: new Date() })), $slice: -500 } },
    },
    { upsert: true },
  );
  if (limitHit) notify(`Ingest daily limit (${limit}) reached`, { runId, client: req.client });
  return { runId, results, summary };
}

/* ------------------------------------------------------------------ lookups for collectors (minimal data) */

export async function lookupEntities(name: string) {
  const out = [];
  for (const [type, model] of [["property", Property], ["company", Company]] as const) {
    const key = nameKey(name);
    const exact = key ? await (model as typeof Property).find({ nameKeys: key }).limit(5).lean() : [];
    const f = search.filter(name);
    const fuzzy = f
      ? await (model as typeof Property).find({ ...f, _id: { $nin: exact.map((e) => e._id) } }).sort({ collabCount: -1 }).limit(5).lean()
      : [];
    for (const [doc, exactMatch] of [...exact.map((d) => [d, true] as const), ...fuzzy.map((d) => [d, false] as const)]) {
      out.push({
        type,
        slug: doc.slug,
        name: { ko: doc.name.ko ?? null, en: doc.name.en ?? null, original: doc.name.original ?? null },
        aliases: doc.aliases.slice(0, 10),
        ...("kind" in doc ? { kind: doc.kind } : {}),
        exact: exactMatch,
      });
    }
  }
  return out;
}

export async function lookupCollabs(q: { q?: string; from?: string; to?: string; limit: number }) {
  const and: Record<string, unknown>[] = [];
  if (q.q) {
    const f = search.filter(q.q);
    if (f) and.push(f);
  }
  if (q.from) and.push({ "period.start": { $gte: parseDateInput(q.from) } });
  if (q.to) and.push({ "period.start": { $lt: new Date(parseDateInput(q.to).getTime() + 86_400_000) } });
  const docs = await Collab.find(and.length ? { $and: and } : {})
    .sort({ "period.start": -1, _id: -1 })
    .limit(q.limit)
    .select({ slug: 1, status: 1, i18n: 1, parties: 1, period: 1, sources: 1 })
    .lean();
  return docs.map((d) => ({
    slug: d.slug,
    status: d.status,
    title: { ko: d.i18n?.ko?.title ?? null, en: d.i18n?.en?.title ?? null },
    parties: d.parties.map((p) => ({ role: p.role, name: p.name?.en || p.name?.ko || null })),
    start: d.period?.start?.toISOString().slice(0, 10) ?? null,
    sourceUrls: d.sources.map((s) => s.url),
  }));
}
