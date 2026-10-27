import { z } from "zod";
import { Bilingual, IsoDate, Locale, patchOf } from "./common.js";

/** `1.4.0`, `v2`, `2026.10`: starts with a letter or digit, then letters, digits, `.`, `-`, `+`. */
export const ChangelogVersion = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/, "version may only use letters, digits, '.', '-' and '+'");

/**
 * One release note on the public changelog page. The body is Markdown, in Korean and English.
 * Unpublished entries are only visible in the admin.
 */
export const ChangelogInput = z.object({
  version: ChangelogVersion,
  /** Release day (UTC). Entries are listed newest first. */
  date: IsoDate.refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), "not a calendar date"),
  body: Bilingual(10_000),
  published: z.boolean().default(false),
});
export type ChangelogInput = z.infer<typeof ChangelogInput>;

export const ChangelogPatch = patchOf(ChangelogInput);
export type ChangelogPatch = z.infer<typeof ChangelogPatch>;

export const ChangelogListQuery = z.object({
  locale: Locale.default("ko"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ChangelogListQuery = z.infer<typeof ChangelogListQuery>;
