import type { FollowUpChanges, FollowUpListQuery, FollowUpReport, FollowUpResolution, SourceInput } from "@gamecollabs/schema";
import type { Principal } from "../auth/principal.js";
import { HttpError, notFound } from "../lib/errors.js";
import { ESCALATE_AFTER, followUpReasonOf, followUpReset, nextCheckAt } from "../lib/followUp.js";
import { formatDate, type Precision } from "../lib/period.js";
import { notify } from "../lib/outbound.js";
import { Collab, type CollabDoc, type CollabFields } from "../models/collab.js";
import { getById, patchCollab } from "./collabs.js";

const ACTIVE = ["draft", "in_review", "published"];

type Proposal = { changes: FollowUpChanges; sources: SourceInput[]; note: string | null; rev: number; by: string; at: Date };

type LeanFollowUp = Pick<CollabFields, "slug" | "status" | "rev" | "i18n" | "parties" | "period" | "sources" | "followUp"> & { _id: { toString(): string } };

/** What a checker needs to look the collab up again. */
function followUpRow(d: LeanFollowUp) {
  const precision = (d.period?.precision ?? "day") as Precision;
  const f = d.followUp;
  return {
    id: d._id.toString(),
    slug: d.slug,
    status: d.status,
    rev: d.rev,
    reason: f?.reason ?? null,
    title: { ko: d.i18n?.ko?.title ?? null, en: d.i18n?.en?.title ?? null },
    summary: { ko: d.i18n?.ko?.summary ?? null, en: d.i18n?.en?.summary ?? null },
    parties: d.parties.map((p) => ({ role: p.role, name: p.name?.en || p.name?.ko || null })),
    period: {
      start: formatDate(d.period?.start, precision),
      end: formatDate(d.period?.end, precision),
      precision,
      endKind: d.period?.endKind ?? "fixed",
    },
    sourceUrls: d.sources.map((s) => s.url),
    lastCheckedAt: f?.lastCheckedAt ?? null,
    nextCheckAt: f?.nextCheckAt ?? null,
    uncheckedRuns: f?.unchanged ?? 0,
    escalated: !!f?.escalatedAt,
    proposal: (f?.proposal as Proposal | null) ?? null,
  };
}

/**
 * `due`: collabs whose next check date has passed (oldest first), skipping those with a
 * proposal waiting for an admin. `proposals` / `escalated`: what an admin has to decide.
 */
export async function listFollowUps(q: FollowUpListQuery, now = new Date()) {
  const base = { status: { $in: ACTIVE }, "followUp.reason": { $ne: null } };
  const [filter, sort]: [Record<string, unknown>, Record<string, 1>] =
    q.view === "due"
      ? [{ ...base, "followUp.nextCheckAt": { $lte: now }, "followUp.proposal": null }, { "followUp.nextCheckAt": 1 }]
      : q.view === "proposals"
        ? [{ status: { $in: ACTIVE }, "followUp.proposal": { $ne: null } }, { "followUp.proposal.at": 1 }]
        : [{ ...base, "followUp.escalatedAt": { $ne: null } }, { "followUp.escalatedAt": 1 }];
  const docs = await Collab.find(filter)
    .sort({ ...sort, _id: 1 })
    .limit(q.limit)
    .select({ slug: 1, status: 1, rev: 1, i18n: 1, parties: 1, period: 1, sources: 1, followUp: 1 })
    .lean();
  return docs.map((d) => followUpRow(d as LeanFollowUp));
}

/** Stored sources plus the new ones, as patch input (duplicates are dropped by `toSources`). */
function mergedSources(doc: CollabDoc, added: SourceInput[]): SourceInput[] {
  const stored = doc.sources.map((s) => ({
    url: s.url,
    title: s.title ?? null,
    publisher: s.publisher ?? null,
    type: s.type as SourceInput["type"],
    isPrimary: !!s.isPrimary,
    accessedAt: s.accessedAt ? s.accessedAt.toISOString().slice(0, 10) : null,
    archiveUrl: s.archiveUrl ?? null,
  }));
  return [...stored, ...added.map((s) => ({ ...s, isPrimary: false }))].slice(0, 20);
}

function patchOf(doc: CollabDoc, changes: FollowUpChanges, sources: SourceInput[]) {
  return {
    ...(changes.period ? { period: changes.period } : {}),
    ...(changes.i18n ? { i18n: changes.i18n } : {}),
    sources: mergedSources(doc, sources),
  };
}

/** Bookkeeping only: never bumps `rev` or `updatedAt`. */
async function setFollowUp(id: CollabDoc["_id"], fields: Record<string, unknown>) {
  await Collab.updateOne({ _id: id }, { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`followUp.${k}`, v])) }, { timestamps: false });
}

/** After a change was applied: restart the schedule for whatever is still missing. */
async function restartSchedule(id: string, now: Date) {
  const doc = await getById(id);
  await setFollowUp(doc._id, { ...followUpReset(followUpReasonOf(doc, now), now), lastCheckedAt: now, proposal: null });
  return getById(id);
}

/**
 * Records one re-check. `no_change` pushes the next check back (3 → 7 → 14 → 30 days) and
 * escalates once after {@link ESCALATE_AFTER} checks in a row. `updated` edits drafts directly
 * (with rev check and revision history); anything else gets a proposal for an admin.
 */
export async function reportFollowUp(idOrSlug: string, report: FollowUpReport, actor: Principal, now = new Date()) {
  const doc = await getById(idOrSlug);
  if (!ACTIVE.includes(doc.status)) throw new HttpError(409, "not_followed_up", `${doc.status} collabs are not re-checked`);
  if (doc.followUp?.proposal) throw new HttpError(409, "proposal_pending", "a proposal for this collab is waiting for an admin");

  if (report.outcome === "no_change") {
    const unchanged = (doc.followUp?.unchanged ?? 0) + 1;
    const escalate = unchanged >= ESCALATE_AFTER && !doc.followUp?.escalatedAt;
    const next = doc.followUp?.reason ? nextCheckAt(unchanged, now) : null;
    await setFollowUp(doc._id, {
      lastCheckedAt: now,
      unchanged,
      nextCheckAt: next,
      ...(escalate ? { escalatedAt: now } : {}),
    });
    if (escalate) {
      notify(`Follow-up: ${doc.slug} still has ${doc.followUp?.reason} after ${unchanged} checks; decide (set dates, endKind permanent, or archive)`, {
        slug: doc.slug,
        reason: doc.followUp?.reason,
        note: report.note ?? null,
      });
    }
    return { result: "recorded" as const, slug: doc.slug, escalated: escalate || !!doc.followUp?.escalatedAt, nextCheckAt: next };
  }

  const changes = report.changes!;
  if (doc.rev !== report.rev) throw new HttpError(412, "rev_conflict", `stored rev is ${doc.rev}`);

  if (doc.status === "draft") {
    await patchCollab(doc._id.toString(), patchOf(doc, changes, report.sources), report.rev!, actor);
    const updated = await restartSchedule(doc._id.toString(), now);
    return { result: "applied" as const, slug: updated.slug, rev: updated.rev, reason: updated.followUp?.reason ?? null };
  }

  const proposal: Proposal = { changes, sources: report.sources, note: report.note ?? null, rev: doc.rev, by: actor.label, at: now };
  await setFollowUp(doc._id, { proposal, lastCheckedAt: now });
  notify(`Follow-up proposal for ${doc.status} collab ${doc.slug}`, { slug: doc.slug, changes, sources: report.sources.map((s) => s.url), note: report.note ?? null });
  return { result: "proposed" as const, slug: doc.slug };
}

/** Admin decision on a pending proposal. `apply` goes through the normal PATCH (rev check, history, publish rules). */
export async function resolveFollowUp(idOrSlug: string, input: FollowUpResolution, ifMatch: number | null, actor: Principal, now = new Date()) {
  const doc = await getById(idOrSlug);
  const proposal = doc.followUp?.proposal as Proposal | null | undefined;
  if (!proposal) throw notFound("follow-up proposal");
  if (input.action === "dismiss") {
    await setFollowUp(doc._id, { proposal: null, nextCheckAt: doc.followUp?.reason ? nextCheckAt(doc.followUp?.unchanged ?? 0, now) : null });
    return getById(doc._id.toString());
  }
  await patchCollab(doc._id.toString(), patchOf(doc, proposal.changes, proposal.sources), ifMatch, actor);
  return restartSchedule(doc._id.toString(), now);
}

/**
 * Daily: re-derives every reason (time moves collabs out of `month_only`, ended ones drop out)
 * and backfills collabs stored before the queue existed. New reasons are due right away.
 */
export async function refreshFollowUps(now = new Date()) {
  let changed = 0;
  for await (const c of Collab.find().select({ status: 1, period: 1, followUp: 1 }).lean().cursor()) {
    const reason = followUpReasonOf(c, now);
    if (reason === (c.followUp?.reason ?? null)) continue;
    await setFollowUp(c._id, followUpReset(reason, now, true));
    changed++;
  }
  const dueFilter: Record<string, unknown> = { status: { $in: ACTIVE }, "followUp.reason": { $ne: null }, "followUp.nextCheckAt": { $lte: now }, "followUp.proposal": null };
  const due = await Collab.countDocuments(dueFilter);
  return { changed, due };
}
