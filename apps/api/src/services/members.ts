import type { Types } from "mongoose";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { Bookmark, Follow, Member } from "../models/member.js";
import type { EntityType } from "./entities.js";

/** How many members saved each collab (ids with no bookmarks are absent → 0). */
export async function bookmarkCounts(collabIds: Types.ObjectId[]): Promise<Map<string, number>> {
  if (!collabIds.length) return new Map();
  const rows = await Bookmark.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { collabId: { $in: collabIds } } },
    { $group: { _id: "$collabId", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.n]));
}

/** How many members follow each property or company. */
export async function followerCounts(type: EntityType, ids: Types.ObjectId[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await Follow.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { targetType: type, targetId: { $in: ids } } },
    { $group: { _id: "$targetId", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.n]));
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKS = 12;

/** Monday 00:00 UTC of the week that contains `d`. */
function weekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
}

/**
 * Admin dashboard numbers. No personal data: counts, weekly sign-ups (Monday-based,
 * UTC, last 12 weeks, zero-filled) and the most saved collabs / followed entities.
 */
export async function memberStats(now = new Date()) {
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  const firstWeek = new Date(weekStart(now).getTime() - (WEEKS - 1) * 7 * DAY);
  const [total, disabled, new7d, new30d, active30d, weekly, bookmarks, follows, topSaved, topFollowed] = await Promise.all([
    Member.countDocuments(),
    Member.countDocuments({ active: false }),
    Member.countDocuments({ createdAt: { $gte: since(7) } }),
    Member.countDocuments({ createdAt: { $gte: since(30) } }),
    Member.countDocuments({ lastLoginAt: { $gte: since(30) } }),
    Member.aggregate<{ _id: Date; n: number }>([
      { $match: { createdAt: { $gte: firstWeek } } },
      { $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "week", startOfWeek: "monday", timezone: "UTC" } }, n: { $sum: 1 } } },
    ]),
    Bookmark.countDocuments(),
    Follow.countDocuments(),
    Bookmark.aggregate<{ _id: Types.ObjectId; n: number }>([{ $group: { _id: "$collabId", n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 10 }]),
    Follow.aggregate<{ _id: { type: EntityType; id: Types.ObjectId }; n: number }>([
      { $group: { _id: { type: "$targetType", id: "$targetId" }, n: { $sum: 1 } } },
      { $sort: { n: -1, "_id.id": 1 } },
      { $limit: 10 },
    ]),
  ]);

  const byWeek = new Map(weekly.map((w) => [w._id.toISOString().slice(0, 10), w.n]));
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const week = new Date(firstWeek.getTime() + i * 7 * DAY).toISOString().slice(0, 10);
    return { week, signups: byWeek.get(week) ?? 0 };
  });

  const entityIds = (type: EntityType) => topFollowed.filter((f) => f._id.type === type).map((f) => f._id.id);
  const [collabs, properties, companies] = await Promise.all([
    Collab.find({ _id: { $in: topSaved.map((t) => t._id) } }, { slug: 1, status: 1, i18n: 1 }).lean(),
    Property.find({ _id: { $in: entityIds("property") } }, { slug: 1, name: 1 }).lean(),
    Company.find({ _id: { $in: entityIds("company") } }, { slug: 1, name: 1 }).lean(),
  ]);
  const collabById = new Map(collabs.map((c) => [c._id.toString(), c]));
  const entityById = new Map([...properties, ...companies].map((e) => [e._id.toString(), e]));

  return {
    members: { total, active: total - disabled, disabled, new7d, new30d, active30d },
    weekly: weeks,
    bookmarks,
    follows,
    topSaved: topSaved.flatMap((t) => {
      const c = collabById.get(t._id.toString());
      return c ? [{ id: c._id.toString(), slug: c.slug, title: c.i18n?.ko?.title ?? c.slug, status: c.status, count: t.n }] : [];
    }),
    topFollowed: topFollowed.flatMap((t) => {
      const e = entityById.get(t._id.id.toString());
      return e ? [{ type: t._id.type, id: e._id.toString(), slug: e.slug, name: e.name?.ko ?? e.slug, count: t.n }] : [];
    }),
  };
}
