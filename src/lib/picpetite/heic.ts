/**
 * HEIC/HEIF detection and pre-conversion to JPEG.
 *
 * Adapted from PicPetite's `apps/web/src/features/drop-zone/use-file-intake.ts`.
 * Only the three pure helpers are extracted here — none of the surrounding
 * React/Zustand code came along.
 *
 * iOS users routinely send HEIC photos. The @jsquash codecs do not handle
 * HEIC, so we pre-convert to JPEG with `heic2any` (lazy-imported on demand)
 * before handing the file off to the compression worker.
 *
 * Detection is three-pronged because iOS sometimes lies about the MIME type:
 *   1. MIME (`image/heic` or `image/heif`)
 *   2. File extension (`.heic` / `.heif`)
 *   3. Magic bytes (ISO BMFF `ftyp` box with a HEIF brand)
 */

/** Check first 12 bytes for HEIC/HEIF container signatures. */
export function isHeicBytes(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const view = new Uint8Array(reader.result as ArrayBuffer);
      // ISO BMFF: bytes 4-7 must be "ftyp". The length guard makes the
      // subsequent indexed accesses safe; non-null assertions silence
      // Yapgone's `noUncheckedIndexedAccess` strict setting.
      if (view.length < 12) return resolve(false);
      const ftyp =
        view[4]! === 0x66 && view[5]! === 0x74 && view[6]! === 0x79 && view[7]! === 0x70;
      if (!ftyp) return resolve(false);
      // Brand at bytes 8-11: heic, heix, mif1, msf1, hevc, hevx
      const brand = String.fromCharCode(view[8]!, view[9]!, view[10]!, view[11]!);
      resolve(["heic", "heix", "mif1", "msf1", "hevc", "hevx"].includes(brand));
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 12));
  });
}

export function isHeicMime(type: string): boolean {
  return type === "image/heic" || type === "image/heif";
}

/**
 * Check all three signals (MIME, extension, magic bytes). The magic-byte
 * check is only run when the MIME is `image/jpeg`, since iOS sometimes
 * mislabels HEIC files that way; otherwise we trust the MIME/extension.
 */
export async function isHeicFile(file: File): Promise<boolean> {
  if (isHeicMime(file.type)) return true;
  if (/\.hei[cf]$/i.test(file.name)) return true;
  if (file.type === "image/jpeg") return isHeicBytes(file);
  return false;
}

/**
 * Convert a HEIC/HEIF file to JPEG via the lazy-loaded `heic2any` library.
 * The library is only fetched on the first HEIC file the user picks — users
 * who never touch HEIC pay zero bytes for it.
 */
export async function convertHeicToJpeg(file: File): Promise<File> {
  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  });
  // heic2any returns either a single Blob or an array of Blobs (for
  // multi-image HEIC); we use the first frame in either case.
  const blob = Array.isArray(result) ? result[0] : result;
  if (!blob) throw new Error("heic2any returned an empty result");
  const name = file.name.replace(/\.hei[cf]$/i, ".jpg");
  return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
}
