import { extname } from "node:path";
import { Collab, type CollabDoc } from "../models/collab.js";
import { safeFetch } from "../lib/safeFetch.js";
import { putObject, storageEnabled } from "../lib/storage.js";
import { logger } from "../logger.js";

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
    return "mirrored";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ slug: doc.slug, err: message }, "cover mirror failed");
    await Collab.updateOne({ _id: doc._id }, { $set: { "cover.mirrorError": message.slice(0, 300) } });
    return "failed";
  }
}
