import { Router, type Request } from "express";
import { Types } from "mongoose";
import { AdminMemberListQuery, AdminMemberPatch, ObjectIdString } from "@gamecollabs/schema";
import { requireScope } from "../auth/principal.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";
import { notFound, parse } from "../lib/errors.js";
import { escapeRegex } from "../lib/text.js";
import { Bookmark, Follow, Member } from "../models/member.js";
import { memberStats } from "../services/members.js";

/** `/v1/admin/members`: Discord members. Listing and changing them needs `members:manage` (admin only). */
export const adminMembersRouter: Router = Router();

type Lean = {
  _id: Types.ObjectId;
  discordId: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
  active: boolean;
  lastLoginAt?: Date | null;
  createdAt?: Date;
};

async function withCounts(members: Lean[]) {
  const ids = members.map((m) => m._id);
  const count = async (model: typeof Bookmark | typeof Follow) => {
    const rows = await (model as typeof Bookmark).aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { memberId: { $in: ids } } },
      { $group: { _id: "$memberId", n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id.toString(), r.n]));
  };
  const [bookmarks, follows] = await Promise.all([count(Bookmark), count(Follow)]);
  return members.map((m) => ({
    id: m._id.toString(),
    discordId: m.discordId,
    username: m.username,
    globalName: m.globalName ?? null,
    avatar: m.avatar ?? null,
    active: m.active,
    lastLoginAt: m.lastLoginAt?.toISOString() ?? null,
    createdAt: m.createdAt?.toISOString() ?? null,
    bookmarkCount: bookmarks.get(m._id.toString()) ?? 0,
    followCount: follows.get(m._id.toString()) ?? 0,
  }));
}

/** Counts only (no personal data), so editors see it too. */
adminMembersRouter.get("/stats", requireScope("ops:read"), async (_req, res) => {
  res.json({ data: await memberStats() });
});

adminMembersRouter.get("/", requireScope("members:manage"), async (req, res) => {
  const q = parse(AdminMemberListQuery, req.query);
  const filter: Record<string, unknown> = {};
  if (q.status !== "all") filter.active = q.status === "active";
  if (q.q) {
    const name = new RegExp(escapeRegex(q.q), "i");
    filter.$or = [{ username: name }, { globalName: name }, ...(/^\d{17,20}$/.test(q.q) ? [{ discordId: q.q }] : [])];
  }
  const page = q.cursor ? { $and: [filter, afterCursor("createdAt", -1, decodeCursor(q.cursor))] } : filter;
  const [rows, total] = await Promise.all([
    Member.find(page).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean<Lean[]>(),
    Member.countDocuments(filter),
  ]);
  const items = rows.slice(0, q.limit);
  const last = items.at(-1);
  res.json({
    data: await withCounts(items),
    meta: { total, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt ?? null, last._id) : null },
  });
});

const memberId = (req: Request) => new Types.ObjectId(parse(ObjectIdString, req.params.id));

/** Blocking ends the member's open sessions at once: the API checks `active` on every request. */
adminMembersRouter.patch("/:id", requireScope("members:manage"), async (req, res) => {
  const { active } = parse(AdminMemberPatch, req.body);
  const member = await Member.findByIdAndUpdate(memberId(req), { active }, { returnDocument: "after" }).lean<Lean>();
  if (!member) throw notFound("member");
  res.json({ data: (await withCounts([member]))[0] });
});

/** Deletes the member with their bookmarks and follows (e.g. a deletion request by email). */
adminMembersRouter.delete("/:id", requireScope("members:manage"), async (req, res) => {
  const id = memberId(req);
  if (!(await Member.exists({ _id: id }))) throw notFound("member");
  await Promise.all([Bookmark.deleteMany({ memberId: id }), Follow.deleteMany({ memberId: id })]);
  await Member.deleteOne({ _id: id });
  res.status(204).end();
});
