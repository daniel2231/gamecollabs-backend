import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

// Object storage stand-in: records what would be uploaded or deleted.
const stored = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();
const deleted: string[] = [];
vi.mock("../src/lib/storage.js", () => ({
  storageEnabled: () => true,
  putObject: async (key: string, body: Buffer, contentType: string) => {
    stored.set(key, { body, contentType, lastModified: new Date() });
  },
  mediaUrl: (key: string | null | undefined) => (key ? `https://media.example.com/${key}` : null),
  listObjects: async (prefix: string) =>
    [...stored.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, lastModified: v.lastModified })),
  deleteObjects: async (keys: string[]) => {
    for (const k of keys) {
      stored.delete(k);
      deleted.push(k);
    }
  },
}));

const { adminJwt, apiToken, as, draftBody, seedEntities, setupDb, teardownDb } = await import("./helpers.js");
const { Collab } = await import("../src/models/collab.js");
const { cleanupUploads } = await import("../src/services/media.js");

let admin: string;
let e: Awaited<ReturnType<typeof seedEntities>>;

beforeAll(async () => {
  await setupDb();
  admin = await adminJwt("daniel", "admin");
  e = await seedEntities();
});
afterAll(teardownDb);
beforeEach(() => {
  stored.clear();
  deleted.length = 0;
});

/** A JPEG with EXIF (incl. GPS-like comment data) and a 90° orientation flag. */
async function jpeg(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "secret", Artist: "someone" } } })
    .toBuffer();
}

const upload = (token: string, buf: Buffer, name = "cover.jpg", type = "image/jpeg") =>
  as(token).post("/v1/admin/media").attach("file", buf, { filename: name, contentType: type });

describe("POST /v1/admin/media", () => {
  it("re-encodes to WebP under a content-hash key, limits the long edge and drops metadata", async () => {
    const res = await upload(admin, await jpeg(3000, 2000));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { storageKey, url, width, height } = res.body.data;
    expect(storageKey).toMatch(/^covers\/[a-f0-9]{64}\.webp$/);
    expect(url).toBe(`https://media.example.com/${storageKey}`);
    // Orientation 6 rotates the 3000×2000 image to portrait, then the long edge is capped at 1600.
    expect([width, height]).toEqual([1067, 1600]);
    const obj = stored.get(storageKey)!;
    expect(obj.contentType).toBe("image/webp");
    const meta = await sharp(obj.body).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();

    // Same image again → same key (stored once by content).
    const again = await upload(admin, await jpeg(3000, 2000));
    expect(again.body.data.storageKey).toBe(storageKey);
  });

  it("keeps small images at their size and accepts PNG and WebP", async () => {
    const png = await sharp({ create: { width: 640, height: 360, channels: 4, background: "#00ff0080" } }).png().toBuffer();
    const res = await upload(admin, png, "a.png", "image/png");
    expect(res.body.data).toMatchObject({ width: 640, height: 360 });
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).webp().toBuffer();
    expect((await upload(admin, webp, "a.webp", "image/webp")).status).toBe(201);
  });

  it("checks the bytes, not the declared type", async () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
    const res = await upload(admin, gif, "x.jpg", "image/jpeg");
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("unsupported_media_type");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(admin, svg, "x.png", "image/png")).status).toBe(415);
    // Looks like a JPEG but is not decodable.
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    expect((await upload(admin, broken)).body.error.code).toBe("invalid_image");
    expect(stored.size).toBe(0);
  });

  it("refuses files over 5MB and images over the pixel limit", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(admin, big);
    expect(res.status).toBe(413);
    // 8000×8000 = 64M pixels, small on disk.
    const bomb = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "white" } }).png({ compressionLevel: 9 }).toBuffer();
    const r2 = await upload(admin, bomb, "bomb.png", "image/png");
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe("image_too_large");
  });

  it("needs a signed-in editor and the `file` field", async () => {
    expect((await as("nope").post("/v1/admin/media").attach("file", await jpeg(10, 10), "a.jpg")).status).toBe(401);
    const ingest = await apiToken("collector", "ingest");
    expect((await upload(ingest, await jpeg(10, 10))).status).toBe(403);
    const wrongField = await as(admin).post("/v1/admin/media").attach("image", await jpeg(10, 10), "a.jpg");
    expect(wrongField.status).toBe(400);
  });
});

describe("cover in the admin API", () => {
  it("links an upload with PATCH and returns the cover with its URL", async () => {
    const { storageKey, width, height } = (await upload(admin, await jpeg(1200, 675))).body.data;
    expect([width, height]).toEqual([675, 1200]);
    const created = await as(admin).post("/v1/admin/collabs").send(draftBody(e.pubg.id, e.aot.id, { sources: [{ url: "https://example.com/cover" }] }));
    const id = created.body.data.id;
    expect(created.body.data.cover).toBeNull();
    const patched = await as(admin)
      .patch(`/v1/admin/collabs/${id}`)
      .set("if-match", "1")
      .send({ cover: { storageKey, width, height, credit: "Krafton", alt: { ko: "키 비주얼", en: "Key visual" } } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const got = await as(admin).get(`/v1/admin/collabs/${id}`);
    expect(got.body.data.cover).toEqual({
      storageKey,
      url: `https://media.example.com/${storageKey}`,
      originalUrl: null,
      credit: "Krafton",
      alt: { ko: "키 비주얼", en: "Key visual" },
      // Measured after applying the EXIF rotation of the test image (1200×675 → 675×1200).
      width,
      height,
      mirrorError: null,
    });
    // Other fields untouched by the cover-only PATCH.
    expect(got.body.data.parties).toHaveLength(2);
    const cleared = await as(admin).patch(`/v1/admin/collabs/${id}`).set("if-match", "2").send({ cover: null });
    expect(cleared.body.data.cover).toBeNull();
  });
});

describe("cleanup-uploads", () => {
  it("deletes only old uploads that no collab uses", async () => {
    const used = (await upload(admin, await jpeg(100, 50))).body.data.storageKey;
    const orphanOld = (await upload(admin, await jpeg(101, 50))).body.data.storageKey;
    const orphanNew = (await upload(admin, await jpeg(102, 50))).body.data.storageKey;
    await Collab.create({
      slug: "cleanup-check",
      i18n: { ko: { title: "가", summary: "나" }, en: { title: "A", summary: "B" } },
      sources: [{ url: "https://example.com/c" }],
      cover: { storageKey: used },
    });
    const old = new Date(Date.now() - 10 * 86_400_000);
    stored.get(used)!.lastModified = old;
    stored.get(orphanOld)!.lastModified = old;
    stored.set("collabs/x/cover-1.jpg", { body: Buffer.alloc(1), contentType: "image/jpeg", lastModified: old });

    expect(await cleanupUploads()).toEqual({ deleted: 1 });
    expect(deleted).toEqual([orphanOld]);
    expect(stored.has(used) && stored.has(orphanNew) && stored.has("collabs/x/cover-1.jpg")).toBe(true);
    await Collab.deleteOne({ slug: "cleanup-check" });
  });

  it("keeps uploads used as property images", async () => {
    const key = (await upload(admin, await jpeg(103, 50))).body.data.storageKey;
    stored.get(key)!.lastModified = new Date(Date.now() - 10 * 86_400_000);
    const res = await as(admin).patch(`/v1/admin/properties/${e.aot.id}`).send({ image: { storageKey: key } });
    expect(res.body.data.image).toMatchObject({ storageKey: key, url: `https://media.example.com/${key}` });
    expect(await cleanupUploads()).toEqual({ deleted: 0 });
    expect(stored.has(key)).toBe(true);
  });
});
