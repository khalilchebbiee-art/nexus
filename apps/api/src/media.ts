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
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav"
};

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
