import { isValidObjectId } from "mongoose";
import type { ChangelogInput, ChangelogPatch, Locale } from "@gamecollabs/schema";
import type { Principal } from "../auth/principal.js";
import { notFound } from "../lib/errors.js";
import { formatDate } from "../lib/period.js";
import { revalidate } from "../lib/outbound.js";
import { Changelog } from "../models/changelog.js";

type Entry = {
  _id: unknown;
  version: string;
  date: Date;
  body: { ko: string; en: string };
  published?: boolean | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const NEWEST_FIRST = { date: -1, createdAt: -1 } as const;

/** Public page entry: the body in the requested language only. */
export function changelogPublic(e: Entry, locale: Locale) {
  return { id: String(e._id), version: e.version, date: formatDate(e.date), body: e.body[locale] };
}

export function changelogAdmin(e: Entry) {
  return {
    id: String(e._id),
    version: e.version,
    date: formatDate(e.date),
    body: { ko: e.body.ko, en: e.body.en },
    published: !!e.published,
    createdAt: e.createdAt ?? null,
    updatedAt: e.updatedAt ?? null,
  };
}

export async function listPublished(limit: number) {
  return Changelog.find({ published: true }).sort(NEWEST_FIRST).limit(limit).lean<Entry[]>();
}

export async function listAll() {
  return Changelog.find().sort(NEWEST_FIRST).lean<Entry[]>();
}

const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

export async function createEntry(input: ChangelogInput, actor: Principal) {
  const doc = await Changelog.create({ ...input, date: toDate(input.date), createdBy: actor.label, updatedBy: actor.label });
  if (doc.published) revalidate(["changelog"]);
  return doc.toObject() as Entry;
}

/** Fields left out of the patch stay as they are. */
export async function updateEntry(id: string, patch: ChangelogPatch, actor: Principal) {
  if (!isValidObjectId(id)) throw notFound("changelog entry");
  const doc = await Changelog.findById(id);
  if (!doc) throw notFound("changelog entry");
  const wasPublished = doc.published;
  const { date, ...rest } = patch;
  doc.set({ ...rest, ...(date ? { date: toDate(date) } : {}), updatedBy: actor.label });
  await doc.save();
  if (wasPublished || doc.published) revalidate(["changelog"]);
  return doc.toObject() as Entry;
}

export async function deleteEntry(id: string) {
  if (!isValidObjectId(id)) throw notFound("changelog entry");
  const doc = await Changelog.findByIdAndDelete(id).lean<Entry>();
  if (!doc) throw notFound("changelog entry");
  if (doc.published) revalidate(["changelog"]);
}
