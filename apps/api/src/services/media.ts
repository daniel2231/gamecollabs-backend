import { createHash } from "node:crypto";
import { extname } from "node:path";
import sharp, { type OutputInfo } from "sharp";
import { Collab, type CollabDoc } from "../models/collab.js";
import { Property } from "../models/entities.js";
import { HttpError } from "../lib/errors.js";
import { revalidate } from "../lib/outbound.js";
import { safeFetch } from "../lib/safeFetch.js";
import { deleteObjects, listObjects, mediaUrl, putObject, storageEnabled } from "../lib/storage.js";
import { logger } from "../logger.js";
import { tagsFor } from "./collabs.js";

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

/**
 * Copies the cover's original URL into object storage (F-09) and records the
 * storage key. The original URL and credit stay for attribution.
 */
export async function mirrorCover(doc: CollabDoc): Promise<"mirrored" | "skipped" | "failed"> {
  const cover = doc.cover;
  if (!storageEnabled() || !cover?.originalUrl || cover.storageKey) return "skipped";
  try {
    const res = await safeFetch(cover.originalUrl, { maxBytes: 15 * 1024 * 1024, timeoutMs: 15_000 });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
    if (!EXT[type]) throw new Error(`unsupported content-type ${type || "(none)"}`);
    const ext = EXT[type] ?? (extname(new URL(cover.originalUrl).pathname) || ".bin");
    const key = `collabs/${doc.slug}/cover-${Date.now().toString(36)}${ext}`;
    await putObject(key, res.body, type);
    // Direct update: mirroring is bookkeeping, not an editorial change (no rev bump).
    await Collab.updateOne({ _id: doc._id }, { $set: { "cover.storageKey": key, "cover.mirrorError": null } });
    // The public image URL changed (original → our copy): refresh the published pages.
    if (doc.status === "published") revalidate(tagsFor(doc));
    return "mirrored";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ slug: doc.slug, err: message }, "cover mirror failed");
    await Collab.updateOne({ _id: doc._id }, { $set: { "cover.mirrorError": message.slice(0, 300) } });
    return "failed";
  }
}

/* ------------------------------------------------------------------ uploads */

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Decompression-bomb guard: refuse images larger than this many pixels before decoding them. */
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 1600;
export const UPLOAD_PREFIX = "covers/";

/** JPEG, PNG or WebP by their leading bytes; the declared content type is not trusted. */
export function sniffImage(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Re-encodes an uploaded cover: honours the EXIF orientation, drops all metadata
 * (EXIF, GPS, ICC comments), converts to WebP with the long edge at most 1600px and
 * stores it under a content-hash key, so the same image is stored once and the
 * public URL never changes (cached as immutable).
 */
export async function storeUpload(buf: Buffer): Promise<{ storageKey: string; url: string | null; width: number; height: number }> {
  if (!storageEnabled()) throw new HttpError(503, "storage_unavailable", "object storage is not configured");
  if (buf.length > UPLOAD_MAX_BYTES) throw new HttpError(413, "payload_too_large", "image is larger than 5MB");
  if (!sniffImage(buf)) throw new HttpError(415, "unsupported_media_type", "only JPEG, PNG and WebP images are accepted");
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pixel limit/i.test(message)) throw new HttpError(422, "image_too_large", `image exceeds ${MAX_INPUT_PIXELS} pixels`);
    throw new HttpError(422, "invalid_image", "the image could not be decoded");
  }
  const storageKey = `${UPLOAD_PREFIX}${createHash("sha256").update(out.data).digest("hex")}.webp`;
  await putObject(storageKey, out.data, "image/webp");
  return { storageKey, url: mediaUrl(storageKey), width: out.info.width, height: out.info.height };
}

/**
 * Deletes uploaded images (`covers/…`) that no collab cover or property image points to and that are older
 * than `graceDays`, so an upload whose collab was never saved does not stay forever.
 * The grace period also keeps a recently replaced cover available for undoing an edit.
 */
export async function cleanupUploads(graceDays = 7, now = new Date()) {
  if (!storageEnabled()) return { skipped: true };
  const keys = [...(await Collab.distinct("cover.storageKey")), ...(await Property.distinct("image.storageKey"))];
  const used = new Set(keys.filter((k): k is string => typeof k === "string"));
  const cutoff = now.getTime() - graceDays * 86_400_000;
  const orphans = (await listObjects(UPLOAD_PREFIX))
    .filter((o) => !used.has(o.key) && o.lastModified && o.lastModified.getTime() < cutoff)
    .map((o) => o.key);
  if (orphans.length) await deleteObjects(orphans);
  logger.info({ deleted: orphans.length }, "cleanup-uploads");
  return { deleted: orphans.length };
}
