import fs from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "./env.js";

/**
 * Media storage abstraction. Two backends:
 *
 *   - "cloud": Cloudflare R2 (S3-compatible). Durable; survives redeploys.
 *   - "local": disk under ./uploads. Ephemeral on most PaaS — dev / fallback.
 *
 * The backend is "cloud" only when MEDIA_STORAGE_PROVIDER=cloud AND every R2
 * credential is present; otherwise it transparently falls back to local disk,
 * so a partial/empty configuration can never break uploads.
 *
 * Uploads always hit local disk first (via multer), then — when cloud is on —
 * the temp file is streamed to R2 and removed, so large files never have to be
 * buffered in memory.
 */
export const isCloudStorage = Boolean(
  env.MEDIA_STORAGE_PROVIDER === "cloud" &&
    env.R2_ENDPOINT &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY &&
    env.R2_BUCKET
);

const s3 = isCloudStorage
  ? new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!
      }
    })
  : null;

type UploadedFile = { path: string; filename: string; mimetype: string; size: number };

/**
 * Finalises a multer upload and returns the public URL clients should use.
 * `prefix` is an optional folder (e.g. "recordings").
 */
export async function persistUpload(file: UploadedFile, prefix = ""): Promise<string> {
  const fullKey = prefix ? `${prefix}/${file.filename}` : file.filename;

  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET!,
        Key: fullKey,
        Body: fs.createReadStream(file.path),
        ContentLength: file.size,
        ContentType: file.mimetype
      })
    );
    fs.unlink(file.path, () => {}); // drop the local temp once it's in R2
  }

  return publicUrlFor(fullKey);
}

function publicUrlFor(fullKey: string): string {
  if (env.MEDIA_PUBLIC_BASE_URL) return `${env.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, "")}/${fullKey}`;
  return `/uploads/${fullKey}`;
}
