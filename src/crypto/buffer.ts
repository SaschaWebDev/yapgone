/**
 * Extracts an ArrayBuffer from a Uint8Array.
 * TS 5.7+ types Uint8Array.buffer as ArrayBufferLike (includes SharedArrayBuffer)
 * but Web Crypto APIs require BufferSource (only ArrayBuffer).
 * We copy through a new Uint8Array to get a guaranteed ArrayBuffer.
 */
export function buf(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}
