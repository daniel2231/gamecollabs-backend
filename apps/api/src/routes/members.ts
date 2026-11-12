import { Router, type Request } from "express";
import type { PipelineStage, Types } from "mongoose";
import { BookmarkListQuery, FeedQuery, FollowType, MAX_BOOKMARKS, MAX_FOLLOWS, MemberDiscordInput, Slug, type FollowType as FollowTypeT } from "@gamecollabs/schema";
import { principal, requireMember, requireScope } from "../auth/principal.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";
import { HttpError, conflict, notFound, parse } from "../lib/errors.js";
import { Collab } from "../models/collab.js";
import { Company, Property } from "../models/entities.js";
import { Bookmark, Follow, Member } from "../models/member.js";
import { findBySlug } from "../services/entities.js";
import { collabCard, pick, publicImage } from "../services/serialize.js";
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
  const [bookmarkCount, followCount] = await Promise.all([visibleBookmarkCount(member._id), Follow.countDocuments({ memberId: member._id })]);
  res.json({ data: { ...memberPublic(member), bookmarkCount, followCount } });
});

/** Deletes the account and everything stored for it. */
meRouter.delete("/", async (req, res) => {
  const id = memberId(req);
  await Promise.all([Bookmark.deleteMany({ memberId: id }), Follow.deleteMany({ memberId: id })]);
  await Member.deleteOne({ _id: id });
  res.status(204).end();
});

/**
 * Everything the web needs to draw save/follow buttons on any page, in one call:
 * slugs of saved (published) collabs and of followed properties and companies.
 */
meRouter.get("/state", async (req, res) => {
  const id = memberId(req);
  const [bookmarks, follows] = await Promise.all([
    Bookmark.aggregate<{ slug: string }>([{ $match: { memberId: id } }, ...withPublishedCollab, { $project: { _id: 0, slug: "$collab.slug" } }]),
    Follow.find({ memberId: id }, { targetType: 1, targetId: 1 }).lean(),
  ]);
  const idsOf = (type: FollowTypeT) => follows.filter((f) => f.targetType === type).map((f) => f.targetId);
  const [properties, companies] = await Promise.all([
    Property.find({ _id: { $in: idsOf("property") } }, { slug: 1 }).lean(),
    Company.find({ _id: { $in: idsOf("company") } }, { slug: 1 }).lean(),
  ]);
  res.json({
    data: {
      bookmarks: bookmarks.map((b) => b.slug),
      follows: { property: properties.map((p) => p.slug), company: companies.map((c) => c.slug) },
    },
  });
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

// ── Follows ────────────────────────────────────────────────────────────────

const followParams = (req: Request) => ({ type: parse(FollowType, req.params.type), slug: parse(Slug, req.params.slug) });

/** Followed properties and companies, most recently followed first (at most MAX_FOLLOWS, so no paging). */
meRouter.get("/follows", async (req, res) => {
  const { locale } = parse(BookmarkListQuery.pick({ locale: true }), req.query);
  const follows = await Follow.find({ memberId: memberId(req) }).sort({ createdAt: -1, _id: -1 }).lean();
  const ids = (type: FollowTypeT) => follows.filter((f) => f.targetType === type).map((f) => f.targetId);
  const [tax, properties, companies] = await Promise.all([
    taxonomy(),
    Property.find({ _id: { $in: ids("property") } }).lean(),
    Company.find({ _id: { $in: ids("company") } }).lean(),
  ]);
  const byId = new Map<string, { type: FollowTypeT; doc: (typeof properties)[number] | (typeof companies)[number] }>([
    ...properties.map((doc) => [doc._id.toString(), { type: "property" as const, doc }] as const),
    ...companies.map((doc) => [doc._id.toString(), { type: "company" as const, doc }] as const),
  ]);
  res.json({
    data: follows.flatMap((f) => {
      const hit = byId.get(f.targetId.toString());
      if (!hit) return [];
      const { type, doc } = hit;
      return [
        {
          type,
          slug: doc.slug,
          name: pick(doc.name, locale),
          kind: "kind" in doc ? tax.labeled(doc.kind, locale) : null,
          image: "image" in doc ? publicImage(doc.image, locale) : null,
          collabCount: doc.collabCount ?? 0,
          followedAt: f.createdAt.toISOString(),
        },
      ];
    }),
  });
});

meRouter.get("/follows/:type/:slug", async (req, res) => {
  const { type, slug } = followParams(req);
  const entity = await findBySlug(type, slug);
  res.json({ data: { following: !!(await Follow.exists({ memberId: memberId(req), targetType: type, targetId: entity._id })) } });
});

/** Idempotent. Accepts a former slug, like the public entity pages. */
meRouter.put("/follows/:type/:slug", async (req, res) => {
  const { type, slug } = followParams(req);
  const id = memberId(req);
  const entity = await findBySlug(type, slug);
  if (!(await Follow.exists({ memberId: id, targetType: type, targetId: entity._id }))) {
    if ((await Follow.countDocuments({ memberId: id })) >= MAX_FOLLOWS) {
      throw conflict("follow_limit", `a member can follow up to ${MAX_FOLLOWS} properties and companies`);
    }
    await Follow.updateOne(
      { memberId: id, targetType: type, targetId: entity._id },
      { $setOnInsert: { memberId: id, targetType: type, targetId: entity._id } },
      { upsert: true },
    );
  }
  res.json({ data: { following: true } });
});

meRouter.delete("/follows/:type/:slug", async (req, res) => {
  const { type, slug } = followParams(req);
  const entity = await findBySlug(type, slug);
  await Follow.deleteOne({ memberId: memberId(req), targetType: type, targetId: entity._id });
  res.json({ data: { following: false } });
});

/**
 * Published collabs of followed properties (any role) and companies, newest
 * published first. Cards have the same shape as `/v1/collabs`.
 */
meRouter.get("/feed", async (req, res) => {
  const q = parse(FeedQuery, req.query);
  const follows = await Follow.find({ memberId: memberId(req) }, { targetType: 1, targetId: 1 }).lean();
  const ids = (type: FollowTypeT) => follows.filter((f) => f.targetType === type).map((f) => f.targetId);
  if (!follows.length) {
    res.json({ data: [], meta: { total: 0, nextCursor: null, locale: q.locale } });
    return;
  }
  const filter: Record<string, unknown> = {
    status: "published",
    $or: [{ "parties.propertyId": { $in: ids("property") } }, { "companies.companyId": { $in: ids("company") } }],
  };
  const page = q.cursor ? { $and: [filter, afterCursor("review.publishedAt", -1, decodeCursor(q.cursor))] } : filter;
  const [items, total, tax] = await Promise.all([
    Collab.find(page).sort({ "review.publishedAt": -1, _id: -1 }).limit(q.limit + 1).lean(),
    Collab.countDocuments(filter),
    taxonomy(),
  ]);
  const pageItems = items.slice(0, q.limit);
  const last = pageItems.at(-1);
  const now = new Date();
  res.json({
    data: pageItems.map((c) => collabCard(c, q.locale, tax, now)),
    meta: { total, nextCursor: items.length > q.limit && last ? encodeCursor(last.review?.publishedAt ?? null, last._id) : null, locale: q.locale },
  });
});
