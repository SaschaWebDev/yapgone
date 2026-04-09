/**
 * Image format identifiers used by the compression core.
 *
 * Adapted from PicPetite's `packages/shared/src/types/image.ts`.
 * Yapgone's compression pipeline only ever targets `webp`, but the worker
 * itself supports all four formats so the source format can vary.
 */
export type ImageFormat = "png" | "jpg" | "webp" | "avif";

export interface CompressionTask {
  id: string;
  imageBuffer: ArrayBuffer;
  sourceFormat: ImageFormat;
  targetFormat: ImageFormat;
  quality: number;
  /**
   * Currently a no-op flag (PicPetite's @jsquash codecs don't actually strip
   * EXIF), but EXIF is dropped as a side effect of the decode→encode round-trip.
   * Kept in the protocol for forward compatibility.
   */
  stripMetadata: boolean;
  /** Hex color (#RRGGBB) used when converting an alpha format to JPEG. */
  bgFillColor?: string;
}

export interface CompressionResult {
  id: string;
  compressedBuffer: ArrayBuffer;
  width: number;
  height: number;
  format: ImageFormat;
}
