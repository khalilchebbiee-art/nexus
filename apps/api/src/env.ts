import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  API_PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  // Optional Redis. When set, Socket.IO uses the Redis pub/sub adapter so
  // multiple API instances share rooms/fan-out (horizontal scale). Unset =
  // single-instance in-memory adapter (dev / free tier).
  REDIS_URL: z.string().url().optional(),
  MEDIA_STORAGE_PROVIDER: z.enum(["local", "cloud"]).default("local"),
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),
  // Cloudflare R2 (S3-compatible) object storage. When all of these are set and
  // MEDIA_STORAGE_PROVIDER=cloud, uploads are streamed to R2 instead of the
  // ephemeral local disk. MEDIA_PUBLIC_BASE_URL should be the bucket's public
  // URL (R2 public dev URL or a custom domain) so clients can fetch media.
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  // Web Push (VAPID). When the key pair is set, the API sends push
  // notifications to offline recipients so messages arrive with the app closed.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@nexus.local"),
  // Comma-separated STUN urls. Defaults to Google's public STUN servers.
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"),
  // Optional TURN relay for restrictive NATs / China network fallback.
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  // SMTP for verification emails. If unset, codes are logged to the API console
  // (development mode) instead of being emailed.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Nexus <no-reply@nexus.local>")
});

export const env = envSchema.parse(process.env);
