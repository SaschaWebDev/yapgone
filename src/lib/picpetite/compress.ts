/**
 * High-level compression API — Yapgone's only entry point into PicPetite's core.
 *
 * This is NOT copied from PicPetite. PicPetite has a Zustand-coupled
 * `ProcessingOrchestrator` and a queue store; Yapgone doesn't need any of
 * that. Instead, we expose a single async function that takes a `File` and
 * returns a `File` (compressed, or the original on fallback / HD mode), and
 * the rest of Yapgone's chat pipeline keeps working unchanged.
 *
 * Design notes:
 *   - The `WorkerPool` is a module-level singleton, lazy-instantiated on the
 *     first call. A user who never uploads an image never spawns a worker
 *     and never downloads any WASM.
 *   - Default target is WebP at quality 78. We do NOT preserve the source
 *     format — every supported image becomes WebP. This is the simplest
 *     mental model for a chat ("just make it smaller, you don't have to
 *     think about formats") and gives 25-35% savings vs JPEG with universal
 *     browser decode support.
 *   - Fallback ladder: HD mode → return original. Animated GIF/WebP →
 *     return original. Compression made it bigger → return original.
 *     Compression threw → return original. Source format we can't decode
 *     → return original. The caller never has to handle errors.
 *   - EXIF stripping is implicit: re-encoding through @jsquash drops all
 *     metadata as a side effect. HD mode skips compression and therefore
 *     preserves EXIF (including GPS). The HD button tooltip should warn
 *     about this.
 */
import type { CompressionTask } from "./types";
import { WorkerPool } from "./worker-pool";
import { mimeToFormat, isAnimated } from "./format-utils";
import { isHeicFile, convertHeicToJpeg } from "./heic";

export interface CompressOptions {
  /** If true, return the original file untouched. */
  hd?: boolean;
  /** WebP quality 1-100. Defaults to 78. */
  quality?: number;
}

export type FallbackReason =
  | "hd"
  | "animated"
  | "unsupported"
  | "ineffective"
  | "error";

export interface CompressResult {
  /** The bytes to actually send (compressed, or original on fallback). */
  file: File;
  /** Original byte size. */
  originalSize: number;
  /** Final byte size. Equal to originalSize on any fallback. */
  finalSize: number;
  /** Did we actually compress? */
  wasCompressed: boolean;
  /** Why we kept the original (only set when `wasCompressed === false`). */
  reason?: FallbackReason;
}

const DEFAULT_QUALITY = 78;

// Module-level singleton — lazy. Importing this file does NOT spawn a worker;
// only the first call to `compressImageForUpload` does.
let pool: WorkerPool | null = null;
function getPool(): WorkerPool {
  if (!pool) pool = new WorkerPool();
  return pool;
}

function makeFallback(file: File, reason: FallbackReason): CompressResult {
  return {
    file,
    originalSize: file.size,
    finalSize: file.size,
    wasCompressed: false,
    reason,
  };
}

function replaceExtensionWithWebp(name: string): string {
  return name.replace(/\.[^./\\]+$/, ".webp") || `${name}.webp`;
}

/**
 * Compress an image File for upload.
 *
 * Always resolves with a `CompressResult`. Never throws — every failure
 * mode falls back to the original file with a `reason`. Callers can
 * unconditionally use `result.file` for the upload.
 */
export async function compressImageForUpload(
  file: File,
  options: CompressOptions = {},
): Promise<CompressResult> {
  const { hd = false, quality = DEFAULT_QUALITY } = options;

  // 1. HD mode: skip compression, preserve original (and its EXIF).
  if (hd) {
    return makeFallback(file, "hd");
  }

  // 2. HEIC pre-conversion (iOS photos). Lazy-loads heic2any.
  let workingFile = file;
  if (await isHeicFile(file)) {
    try {
      workingFile = await convertHeicToJpeg(file);
    } catch {
      return makeFallback(file, "error");
    }
  }

  // 3. Source format must be one we can decode.
  const sourceFormat = mimeToFormat(workingFile.type);
  if (!sourceFormat || sourceFormat === "avif") {
    // AVIF is excluded from Yapgone's bundle on purpose (4 MB encoder).
    // Send the original AVIF bytes — receivers' browsers handle it natively.
    return makeFallback(file, "unsupported");
  }

  // 4. Read bytes once. We'll need them either way.
  let imageBuffer: ArrayBuffer;
  try {
    imageBuffer = await workingFile.arrayBuffer();
  } catch {
    return makeFallback(file, "error");
  }

  // 5. Animated GIF / animated WebP: codecs are single-frame only.
  if (isAnimated(imageBuffer, workingFile.type)) {
    return makeFallback(file, "animated");
  }

  // 6. Dispatch to the worker pool. The first call here boots the worker
  //    and lazy-loads the WASM codecs (~445 KB total, cached after).
  let result;
  try {
    const task: CompressionTask = {
      id: crypto.randomUUID(),
      imageBuffer,
      sourceFormat,
      targetFormat: "webp",
      quality,
      stripMetadata: true,
    };
    result = await getPool().dispatch(task);
  } catch {
    return makeFallback(file, "error");
  }

  // 7. Refuse to make files larger. Some already-optimized inputs (small
  //    JPEGs, photos at low quality) compress to a bigger WebP.
  if (result.compressedBuffer.byteLength >= file.size) {
    return makeFallback(file, "ineffective");
  }

  // 8. Wrap the compressed bytes in a real File so the rest of Yapgone's
  //    pipeline (which reads `file.name`, `file.type`, `file.size`) gets
  //    the right metadata for the gallery-meta / file-meta messages.
  const compressedFile = new File(
    [result.compressedBuffer],
    replaceExtensionWithWebp(file.name),
    { type: "image/webp", lastModified: file.lastModified },
  );

  return {
    file: compressedFile,
    originalSize: file.size,
    finalSize: compressedFile.size,
    wasCompressed: true,
  };
}
