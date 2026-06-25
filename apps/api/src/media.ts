import path from "node:path";

// Maps an upload's mimetype to a safe file extension. The extension is chosen
// by the server from a fixed allow-list so a malicious `originalname` (e.g.
// `x.html`) can never determine how the file is later served.
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/3gpp": ".3gp",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav"
};

// Reverse map: filename extension -> a known media mimetype. Used to recover the
// real type when the browser sends a generic/empty mimetype (e.g. "" or
// "application/octet-stream"), which happens for .mov/.mkv and unmapped files.
const EXTENSION_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".qt": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg"
};

const MEDIA_PREFIXES = ["image/", "video/", "audio/"];

function isMediaMime(mime: string | undefined): boolean {
  return Boolean(mime && MEDIA_PREFIXES.some((prefix) => mime.startsWith(prefix)));
}

// The mimetype to trust for an upload: the browser's if it's a real media type,
// otherwise inferred from the filename extension. Empty string when neither
// identifies a supported media file (caller rejects it).
export function effectiveMime(originalname: string | undefined, mimetype: string | undefined): string {
  if (isMediaMime(mimetype)) return mimetype as string;
  const ext = path.extname(originalname ?? "").toLowerCase();
  return EXTENSION_MIME[ext] ?? "";
}

export function extensionForMime(mime: string): string {
  const known = MIME_EXTENSIONS[mime];
  if (known) return known;
  // Safe per-category fallback for anything that passed the upload filter but
  // isn't explicitly mapped — never an executable/markup extension.
  if (mime.startsWith("image/")) return ".img";
  if (mime.startsWith("video/")) return ".vid";
  if (mime.startsWith("audio/")) return ".aud";
  return ".bin";
}
