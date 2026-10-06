import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

let client: S3Client | null = null;

/** S3-compatible object storage (Cloudflare R2 by default; Garage/S3 by changing the endpoint). */
export function storageEnabled(): boolean {
  const c = config();
  return !!(c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY);
}

function s3(): S3Client {
  const c = config();
  client ??= new S3Client({
    endpoint: c.S3_ENDPOINT,
    region: c.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: c.S3_ACCESS_KEY_ID!, secretAccessKey: c.S3_SECRET_ACCESS_KEY! },
  });
  return client;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: config().S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

/** Only the key is stored in the DB; the public URL is built from MEDIA_BASE_URL. */
export function mediaUrl(storageKey: string | null | undefined): string | null {
  const base = config().MEDIA_BASE_URL;
  if (!storageKey || !base) return null;
  return `${base.replace(/\/+$/, "")}/${storageKey}`;
}
