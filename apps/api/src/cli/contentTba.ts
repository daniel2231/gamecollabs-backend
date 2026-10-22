import { Collab } from "../models/collab.js";
import { Revision } from "../models/support.js";
import { revalidate } from "../lib/outbound.js";
import { tagsFor } from "../services/collabs.js";

/**
 * Wording that says the content (not the dates) is still to come; a date word in between
 * ("구성되며 출시 일정은 추후 공개") means the dates are what is missing. Only a hint for a person:
 * the scan prints matches and changes nothing unless `apply` is set.
 */
const PATTERNS: RegExp[] = [
  /(내용|상세|세부|자세한|구성|보상|아이템|상품|굿즈|메뉴|라인업|혜택)(?:(?!일정|날짜|일자|기간|시기|출시일|발매일|판매일)[^.。]){0,20}(추후|미정|공개 예정|발표 예정|공개될 예정|발표될 예정|안내 예정|안내될 예정)/,
  /(추후|차후)[^.。]{0,10}(공개|발표|안내)될?\s*(예정|계획)?[^.。]{0,10}(내용|상세|세부|구성|보상|아이템|상품|굿즈|메뉴)/,
  /\b(details?|content|rewards?|items?|line-?up|merch(andise)?|menu|more information)\b(?:(?!schedule|date|release|launch|period)[^.]){0,40}\b(to be announced|TBA|TBD|will be (revealed|announced|shared|unveiled)|(revealed|announced) later|coming soon)\b/i,
  /\bstay tuned\b/i,
];

const ACTIVE = ["draft", "in_review", "published"];

type Text = { title?: string | null; summary?: string | null; note?: string | null } | null | undefined;

export function matchOf(texts: Text[]): string | null {
  for (const t of texts) {
    for (const s of [t?.summary, t?.note]) {
      if (!s) continue;
      for (const re of PATTERNS) {
        const m = s.match(re);
        if (m) return m[0];
      }
    }
  }
  return null;
}

/**
 * Finds active, not yet ended collabs whose text suggests the content is not announced.
 * `apply`: set `contentTba` on every match, or only on `slugs` when given (any active collab,
 * matched or not). Each change bumps `rev`, is recorded as a revision and is due for a check now.
 */
export async function flagContentTba(opts: { apply: boolean; slugs?: string[] }, now = new Date()) {
  const filter: Record<string, unknown> = {
    status: { $in: ACTIVE },
    contentTba: { $ne: true },
    $or: [{ "period.until": null }, { "period.until": { $gt: now } }],
    ...(opts.slugs?.length ? { slug: { $in: opts.slugs } } : {}),
  };
  const docs = await Collab.find(filter).select({ slug: 1, status: 1, i18n: 1, period: 1 }).sort({ "period.start": -1 }).lean();
  const rows = docs
    .map((d) => ({
      slug: d.slug,
      status: d.status,
      start: d.period?.start?.toISOString().slice(0, 10) ?? null,
      match: matchOf([d.i18n?.ko, d.i18n?.en]),
      summary: d.i18n?.ko?.summary ?? d.i18n?.en?.summary ?? null,
    }))
    .filter((r) => opts.slugs?.length || r.match);

  const missing = opts.slugs?.filter((s) => !rows.some((r) => r.slug === s)) ?? [];
  if (!opts.apply) return { applied: false, count: rows.length, rows, missing };

  const flagged: string[] = [];
  for (const r of rows) {
    const doc = await Collab.findOne({ slug: r.slug });
    if (!doc || doc.contentTba) continue;
    doc.contentTba = true;
    await doc.save();
    await Collab.updateOne({ _id: doc._id }, { $set: { "followUp.nextCheckAt": now } }, { timestamps: false });
    await Revision.create({ collabId: doc._id, rev: doc.rev, actorLabel: "cli:flag-content-tba", action: "update", diff: { contentTba: { from: false, to: true } } });
    if (doc.status === "published") revalidate(tagsFor(doc));
    flagged.push(doc.slug);
  }
  return { applied: true, count: flagged.length, flagged, missing };
}
