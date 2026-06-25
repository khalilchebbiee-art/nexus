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
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/rtf": ".rtf",
  "application/zip": ".zip",
  "application/json": ".json"
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
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".json": "application/json"
};

const MEDIA_PREFIXES = ["image/", "video/", "audio/"];

// Document mimetypes allowed as FILE attachments. Note: text/html and
// image/svg+xml are intentionally absent — they could execute script if served
// inline. (helmet also sends X-Content-Type-Options: nosniff as defence.)
const DOC_MIMES = new Set(Object.values(EXTENSION_MIME).filter((mime) => mime.startsWith("application/") || mime.startsWith("text/")));

// Strip codec params / casing: "video/webm;codecs=vp9,opus" -> "video/webm".
// Browsers send these on MediaRecorder uploads; the base type drives mapping.
function normalizeMime(mime: string | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

function isMediaMime(mime: string): boolean {
  return MEDIA_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isAllowedMime(mime: string): boolean {
  return Boolean(mime) && (isMediaMime(mime) || DOC_MIMES.has(mime));
}

// The mimetype to trust for an upload: the browser's (normalized) if it's an
// allowed media/document type, otherwise inferred from the filename extension.
// Empty string when neither identifies a supported file (caller rejects it).
export function effectiveMime(originalname: string | undefined, mimetype: string | undefined): string {
  const base = normalizeMime(mimetype);
  if (isAllowedMime(base)) return base;
  const ext = path.extname(originalname ?? "").toLowerCase();
  return EXTENSION_MIME[ext] ?? "";
}

// Message type bucket for a resolved mimetype.
export function messageKindForMime(mime: string): "IMAGE" | "VIDEO" | "VOICE" | "FILE" {
  const base = normalizeMime(mime);
  if (base.startsWith("image/")) return "IMAGE";
  if (base.startsWith("video/")) return "VIDEO";
  if (base.startsWith("audio/")) return "VOICE";
  return "FILE";
}

export function extensionForMime(mime: string): string {
  const base = normalizeMime(mime);
  const known = MIME_EXTENSIONS[base];
  if (known) return known;
  // Safe per-category fallback for anything that passed the upload filter but
  // isn't explicitly mapped — never an executable/markup extension.
  if (base.startsWith("image/")) return ".img";
  if (base.startsWith("video/")) return ".vid";
  if (base.startsWith("audio/")) return ".aud";
  return ".bin";
}
