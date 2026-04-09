/**
 * Format detection helpers.
 *
 * Adapted from PicPetite's `apps/web/src/lib/format-utils.ts`. Only the type
 * import path was changed.
 *
 * Yapgone uses these for:
 *   - Mapping File.type → ImageFormat for the worker dispatch.
 *   - Detecting animated GIF/WebP so we can fall back to the original (the
 *     codecs only handle single-frame images).
 */
import type { ImageFormat } from "./types";

export function mimeToFormat(mime: string): ImageFormat | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

export function formatToMime(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
  }
}

export function hasAlphaChannel(imageData: ImageData): boolean {
  const data = imageData.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}

export function isAnimatedGif(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer);
  // Count GIF frame markers (0x00 0x21 0xF9). Loop bound `view.length - 2`
  // guarantees `view[i + 1]` is in range; non-null assertion for strictness.
  let frames = 0;
  for (let i = 0; i < view.length - 2; i++) {
    if (view[i] === 0x21 && view[i + 1]! === 0xf9) {
      frames++;
      if (frames > 1) return true;
    }
  }
  return false;
}

export function isAnimatedWebP(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer);
  // Check for VP8X chunk with animation flag
  // RIFF....WEBPVP8X
  if (view.length < 30) return false;

  // Find VP8X chunk
  const decoder = new TextDecoder();
  for (let i = 12; i < Math.min(view.length - 4, 100); i++) {
    if (decoder.decode(view.slice(i, i + 4)) === "VP8X") {
      // Animation flag is bit 1 of the byte at offset +8 from chunk start.
      // Bounds: i + 8 < min(view.length - 4, 100) + 8 ≤ view.length + 4, but
      // we have view.length ≥ 30 from the early return above, and i ≤ 96, so
      // i + 8 ≤ 104 — needs an explicit bounds check before reading.
      if (i + 8 >= view.length) return false;
      const flags = view[i + 8]!;
      return (flags & 0x02) !== 0;
    }
  }
  return false;
}

export function isAnimated(buffer: ArrayBuffer, mimeType: string): boolean {
  if (mimeType === "image/gif") return isAnimatedGif(buffer);
  if (mimeType === "image/webp") return isAnimatedWebP(buffer);
  return false;
}
