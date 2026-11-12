import { Router, type Request } from "express";
import type { PipelineStage, Types } from "mongoose";
import { BookmarkListQuery, MAX_BOOKMARKS, MemberDiscordInput, Slug } from "@gamecollabs/schema";
import { principal, requireMember, requireScope } from "../auth/principal.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";
import { HttpError, conflict, notFound, parse } from "../lib/errors.js";
import { Collab } from "../models/collab.js";
import { Bookmark, Member } from "../models/member.js";
import { collabCard } from "../services/serialize.js";
import { taxonomy } from "../services/taxonomy.js";

type MemberLean = { _id: Types.ObjectId; discordId: string; username: string; globalName?: string | null; avatar?: string | null; createdAt?: Date };

function memberPublic(m: MemberLean) {
  return {
    id: m._id.toString(),
    discordId: m.discordId,
    username: m.username,
    globalName: m.globalName ?? null,
    avatar: m.avatar ?? null,
    createdAt: m.createdAt?.toISOString() ?? null,
  };
}

/** `/v1/members`: called by the Next.js server with the service token. */
export const membersRouter: Router = Router();

/** Creates the member on first login, refreshes the Discord profile afterwards. */
membersRouter.post("/discord", requireScope("members:write"), async (req, res) => {
  const input = parse(MemberDiscordInput, req.body);
  const existing = await Member.findOne({ discordId: input.discordId }, { active: 1 }).lean();
  if (existing && !existing.active) throw new HttpError(403, "member_disabled", "this account is disabled");
  const member = await Member.findOneAndUpdate(
    { discordId: input.discordId },
    { username: input.username, globalName: input.globalName ?? null, avatar: input.avatar ?? null, lastLoginAt: new Date() },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ).lean<MemberLean>();
  res.status(existing ? 200 : 201).json({ data: memberPublic(member!) });
});

/** `/v1/me`: the signed-in member (member JWT only). */
export const meRouter: Router = Router();
meRouter.use(requireMember);

const memberId = (req: Request) => principal(req).memberId!;

meRouter.get("/", async (req, res) => {
  const member = await Member.findById(memberId(req)).lean<MemberLean>();
  if (!member) throw notFound("member");
  res.json({ data: { ...memberPublic(member), bookmarkCount: await visibleBookmarkCount(member._id) } });
});

/** Deletes the account and everything stored for it. */
meRouter.delete("/", async (req, res) => {
  const id = memberId(req);
  await Bookmark.deleteMany({ memberId: id });
  await Member.deleteOne({ _id: id });
  res.status(204).end();
});

/** Joins each bookmark to its collab and drops collabs that are no longer published. */
const withPublishedCollab: PipelineStage[] = [
  { $lookup: { from: Collab.collection.name, localField: "collabId", foreignField: "_id", as: "collab", pipeline: [{ $match: { status: "published" } }] } },
  { $unwind: "$collab" },
];

async function visibleBookmarkCount(id: Types.ObjectId): Promise<number> {
  const [row] = await Bookmark.aggregate<{ n: number }>([{ $match: { memberId: id } }, ...withPublishedCollab, { $count: "n" }]);
  return row?.n ?? 0;
}

/** Saved collabs, most recently saved first. Cards have the same shape as `/v1/collabs`. */
meRouter.get("/bookmarks", async (req, res) => {
  const q = parse(BookmarkListQuery, req.query);
  const id = memberId(req);
  const match: Record<string, unknown> = { memberId: id };
  if (q.cursor) Object.assign(match, afterCursor("createdAt", -1, decodeCursor(q.cursor)));
  const [rows, total, tax] = await Promise.all([
    Bookmark.aggregate<{ _id: Types.ObjectId; createdAt: Date; collab: Parameters<typeof collabCard>[0] }>([
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      ...withPublishedCollab,
      { $limit: q.limit + 1 },
    ]),
    visibleBookmarkCount(id),
    taxonomy(),
  ]);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const now = new Date();
  res.json({
    data: page.map((r) => ({ ...collabCard(r.collab, q.locale, tax, now), bookmarkedAt: r.createdAt.toISOString() })),
    meta: { total, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last._id) : null, locale: q.locale },
  });
});

const slugParam = (req: Request) => parse(Slug, req.params.slug);

meRouter.get("/bookmarks/:slug", async (req, res) => {
  const collab = await Collab.findOne({ slug: slugParam(req), status: "published" }, { _id: 1 }).lean();
  if (!collab) throw notFound("collab");
  const bookmarked = !!(await Bookmark.exists({ memberId: memberId(req), collabId: collab._id }));
  res.json({ data: { bookmarked } });
});

/** Idempotent: saving a saved collab again changes nothing. */
meRouter.put("/bookmarks/:slug", async (req, res) => {
  const id = memberId(req);
  const collab = await Collab.findOne({ slug: slugParam(req), status: "published" }, { _id: 1 }).lean();
  if (!collab) throw notFound("collab");
  if (!(await Bookmark.exists({ memberId: id, collabId: collab._id }))) {
    if ((await Bookmark.countDocuments({ memberId: id })) >= MAX_BOOKMARKS) {
      throw conflict("bookmark_limit", `a member can keep up to ${MAX_BOOKMARKS} bookmarks`);
    }
    await Bookmark.updateOne({ memberId: id, collabId: collab._id }, { $setOnInsert: { memberId: id, collabId: collab._id } }, { upsert: true });
  }
  res.json({ data: { bookmarked: true } });
});

/** Also removes bookmarks of collabs that were archived since. */
meRouter.delete("/bookmarks/:slug", async (req, res) => {
  const collab = await Collab.findOne({ slug: slugParam(req) }, { _id: 1 }).lean();
  if (!collab) throw notFound("collab");
  await Bookmark.deleteOne({ memberId: memberId(req), collabId: collab._id });
  res.json({ data: { bookmarked: false } });
});
