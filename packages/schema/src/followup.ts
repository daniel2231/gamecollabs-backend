import { z } from "zod";
import { CollabI18n, PeriodInput, SourceInput } from "./collab.js";

/**
 * Why a collab needs another look, derived from its period:
 * - `start_tba`: announced, start date not out yet;
 * - `month_only`: only the start month is known (until that month is over);
 * - `end_tba`: running or upcoming, end not announced;
 * - `end_missing`: `endKind: "fixed"` without an end date (data gap);
 * - `content_tba`: dates complete, but what the collab adds is not announced (`contentTba`).
 */
export const FOLLOW_UP_REASONS = ["start_tba", "month_only", "end_tba", "end_missing", "content_tba"] as const;
export const FollowUpReason = z.enum(FOLLOW_UP_REASONS);
export type FollowUpReason = z.infer<typeof FollowUpReason>;

/**
 * Changes a re-check may bring: dates, text, and `contentTba: false` once the content is announced.
 * New sources are added to the stored ones.
 */
export const FollowUpChanges = z
  .object({
    period: PeriodInput.optional(),
    i18n: CollabI18n.optional(),
    contentTba: z.boolean().optional(),
  })
  .refine((c) => c.period || c.i18n || c.contentTba !== undefined, { message: "give period, i18n and/or contentTba" });
export type FollowUpChanges = z.infer<typeof FollowUpChanges>;

/**
 * Result of re-checking one collab. `no_change` only moves the next check date.
 * `updated` is applied right away to drafts; for collabs under review or published
 * it is stored as a proposal for an admin to apply or dismiss.
 */
export const FollowUpReport = z
  .object({
    outcome: z.enum(["no_change", "updated"]),
    /** Current rev from list_followups (required for `updated`). */
    rev: z.number().int().min(1).optional(),
    changes: FollowUpChanges.optional(),
    /** Sources backing the change (at least one for `updated`); appended to the stored ones. */
    sources: z.array(SourceInput).max(5).default([]),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((r) => r.outcome !== "updated" || !!r.changes, { message: "updated requires changes", path: ["changes"] })
  .refine((r) => r.outcome !== "updated" || r.sources.length > 0, { message: "updated requires at least one source", path: ["sources"] })
  .refine((r) => r.outcome !== "updated" || r.rev !== undefined, { message: "updated requires rev", path: ["rev"] });
export type FollowUpReport = z.infer<typeof FollowUpReport>;

/**
 * `due`: what the collector checks next. `proposals`: changes found for collabs under review or published.
 * `applied`: changes the collector made to drafts that an admin has not looked at yet. `escalated`: no news after many checks.
 */
export const FOLLOW_UP_VIEWS = ["due", "proposals", "applied", "escalated"] as const;
export const FollowUpListQuery = z.object({
  view: z.enum(FOLLOW_UP_VIEWS).default("due"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FollowUpListQuery = z.infer<typeof FollowUpListQuery>;

/** `apply` / `dismiss` a pending proposal; `acknowledge` marks the changes made to a draft as seen. */
export const FollowUpResolution = z.object({ action: z.enum(["apply", "dismiss", "acknowledge"]) });
export type FollowUpResolution = z.infer<typeof FollowUpResolution>;
