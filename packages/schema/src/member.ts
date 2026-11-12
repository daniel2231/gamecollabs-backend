import { z } from "zod";
import { Locale } from "./common.js";

/** Discord user ids are snowflakes: 17–20 digit strings. */
export const DiscordId = z.string().regex(/^\d{17,20}$/, "invalid Discord id");

/**
 * Sent by the Next.js server after a Discord login (service token only), so the
 * API creates or refreshes the member. Only the Discord id identifies a member:
 * usernames and avatars can change and are refreshed on every login.
 */
export const MemberDiscordInput = z.object({
  discordId: DiscordId,
  username: z.string().trim().min(1).max(64),
  globalName: z.string().trim().min(1).max(64).nullish(),
  /** Discord avatar hash, not a URL. */
  avatar: z
    .string()
    .regex(/^(a_)?[a-f0-9]{32}$/, "invalid avatar hash")
    .nullish(),
});
export type MemberDiscordInput = z.infer<typeof MemberDiscordInput>;

/** A member can keep this many bookmarks. */
export const MAX_BOOKMARKS = 500;

export const BookmarkListQuery = z.object({
  locale: Locale.default("ko"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type BookmarkListQuery = z.infer<typeof BookmarkListQuery>;
