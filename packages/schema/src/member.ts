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

/** What a member can follow: a property (game or IP) or a company. */
export const FOLLOW_TYPES = ["property", "company"] as const;
export const FollowType = z.enum(FOLLOW_TYPES);
export type FollowType = z.infer<typeof FollowType>;

/** A member can follow this many properties and companies in total. */
export const MAX_FOLLOWS = 200;

/** Feed of followed properties and companies: newest published first. */
export const FeedQuery = BookmarkListQuery;
export type FeedQuery = z.infer<typeof FeedQuery>;
