/**
 * Compression worker — pure codec dispatch.
 *
 * Adapted verbatim from PicPetite's `apps/web/src/workers/compression.worker.ts`.
 * Only the type import path was changed (PicPetite imports from
 * `@picpetite/shared`; here we use the local `./types` module).
 *
 * The four @jsquash codecs are loaded via dynamic `import()` so the WASM
 * payload is only fetched the first time a compression task actually runs.
 * A user who never uploads an image downloads zero compression bytes.
 *
 * NOTE: Yapgone only ships the JPEG, PNG, and WebP codecs as deps. The AVIF
 * branch in `loadCodecs`/`decode`/`encode` is left in place for parity with
 * PicPetite, but it will throw at runtime if AVIF is ever requested — and the
 * high-level `compress.ts` API in this folder never targets AVIF, so the path
 * is effectively dead code in Yapgone.
 */
import type { ImageFormat } from "./types";

// Lazy-loaded codec modules
let pngCodec: typeof import("@jsquash/png") | null = null;
let jpegCodec: typeof import("@jsquash/jpeg") | null = null;
let webpCodec: typeof import("@jsquash/webp") | null = null;

async function loadCodecs() {
  const [png, jpeg, webp] = await Promise.all([
    import("@jsquash/png"),
    import("@jsquash/jpeg"),
    import("@jsquash/webp"),
  ]);
  pngCodec = png;
  jpegCodec = jpeg;
  webpCodec = webp;
}

async function decode(buffer: ArrayBuffer, format: ImageFormat): Promise<ImageData> {
  switch (format) {
    case "png":
      return pngCodec!.decode(buffer);
    case "jpg":
      return jpegCodec!.decode(buffer);
    case "webp":
      return webpCodec!.decode(buffer);
    case "avif":
      throw new Error("AVIF is not bundled in Yapgone");
  }
}

async function encode(
  imageData: ImageData,
  format: ImageFormat,
  quality: number,
): Promise<ArrayBuffer> {
  switch (format) {
    case "png":
      return pngCodec!.encode(imageData);
    case "jpg":
      return jpegCodec!.encode(imageData, { quality });
    case "webp":
      return webpCodec!.encode(imageData, { quality });
    case "avif":
      throw new Error("AVIF is not bundled in Yapgone");
  }
}

function applyBgFill(imageData: ImageData, bgColor: string): ImageData {
  const r = parseInt(bgColor.slice(1, 3), 16);
  const g = parseInt(bgColor.slice(3, 5), 16);
  const b = parseInt(bgColor.slice(5, 7), 16);

  const data = new Uint8ClampedArray(imageData.data);
  // Iteration is bounded by `data.length`, so the four indexed accesses are
  // always within bounds. The non-null assertions silence Yapgone's
  // `noUncheckedIndexedAccess` strict setting.
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]! / 255;
    data[i] = Math.round(data[i]! * alpha + r * (1 - alpha));
    data[i + 1] = Math.round(data[i + 1]! * alpha + g * (1 - alpha));
    data[i + 2] = Math.round(data[i + 2]! * alpha + b * (1 - alpha));
    data[i + 3] = 255;
  }

  return new ImageData(data, imageData.width, imageData.height);
}

let codecsReady = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data;

  if (type === "INIT") {
    try {
      await loadCodecs();
      codecsReady = true;
      self.postMessage({ type: "READY" });
    } catch (err) {
      self.postMessage({
        type: "ERROR",
        id: "init",
        payload: { message: (err as Error).message },
      });
    }
    return;
  }

  if (type === "COMPRESS") {
    if (!codecsReady) {
      await loadCodecs();
      codecsReady = true;
    }

    try {
      const {
        imageBuffer,
        sourceFormat,
        targetFormat,
        quality,
        stripMetadata: _stripMetadata,
        bgFillColor,
      } = payload;

      // Decode
      let imageData = await decode(imageBuffer, sourceFormat);

      // Apply background fill if converting from alpha format to non-alpha format
      if (bgFillColor && targetFormat === "jpg" && sourceFormat !== "jpg") {
        imageData = applyBgFill(imageData, bgFillColor);
      }

      // Encode
      const compressedBuffer = await encode(imageData, targetFormat, quality);

      self.postMessage(
        {
          type: "RESULT",
          id,
          payload: {
            compressedBuffer,
            width: imageData.width,
            height: imageData.height,
            format: targetFormat,
          },
        },
        { transfer: [compressedBuffer] },
      );
    } catch (err) {
      self.postMessage({
        type: "ERROR",
        id,
        payload: { message: (err as Error).message },
      });
    }
  }
};
