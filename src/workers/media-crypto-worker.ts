// Self-contained Web Worker for WebRTC Encoded Transforms.
// No imports from @/crypto — inline minimal logic to avoid Vite alias issues in worker bundles.

// Frame wire format: [4-byte counter BE | 12-byte IV | encrypted payload + 16-byte GCM tag]
// IV construction: [4-byte random session salt | 4-byte zero padding | 4-byte counter BE]

const HEADER_SIZE = 4 + 12 // counter + IV
const GCM_TAG_SIZE = 16
const IV_SIZE = 12

let aesKey: CryptoKey | null = null
let frameCounter = 0
const sessionSalt = crypto.getRandomValues(new Uint8Array(4))

let keyReady: Promise<void> = Promise.resolve()
let resolveKeyReady: (() => void) | null = null

function writeUint32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = (value >>> 24) & 0xff
  buf[1] = (value >>> 16) & 0xff
  buf[2] = (value >>> 8) & 0xff
  buf[3] = value & 0xff
  return buf
}

function readUint32BE(data: Uint8Array): number {
  return (
    ((data[0] ?? 0) << 24) |
    ((data[1] ?? 0) << 16) |
    ((data[2] ?? 0) << 8) |
    (data[3] ?? 0)
  ) >>> 0
}

function buildIV(counter: number): Uint8Array {
  const iv = new Uint8Array(IV_SIZE)
  iv.set(sessionSalt, 0)
  // bytes 4..7 are zero padding (already zeroed)
  const counterBytes = writeUint32BE(counter)
  iv.set(counterBytes, 8)
  return iv
}

// TS 5.9+ types Uint8Array.buffer as ArrayBufferLike (includes SharedArrayBuffer)
// but Web Crypto requires BufferSource (only ArrayBuffer). Copy to guarantee ArrayBuffer.
function toAB(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength)
  new Uint8Array(copy).set(data)
  return copy
}

type FrameController = { enqueue: (frame: { data: ArrayBuffer }) => void }

function encryptFrame(frame: { data: ArrayBuffer }, controller: FrameController): void | Promise<void> {
  if (!aesKey) return // DROP — never send unencrypted audio
  const counter = frameCounter++
  const iv = buildIV(counter)

  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toAB(iv) },
    aesKey,
    frame.data,
  ).then((encrypted) => {
    const encView = new Uint8Array(encrypted)
    const output = new Uint8Array(HEADER_SIZE + encView.byteLength)
    output[0] = (counter >>> 24) & 0xff
    output[1] = (counter >>> 16) & 0xff
    output[2] = (counter >>> 8) & 0xff
    output[3] = counter & 0xff
    output.set(iv, 4)
    output.set(encView, HEADER_SIZE)
    frame.data = output.buffer
    controller.enqueue(frame)
  }).catch((err) => {
    console.error('[MediaCrypto:encrypt] Error:', err)
  })
}

function decryptFrame(frame: { data: ArrayBuffer }, controller: FrameController): void | Promise<void> {
  if (!aesKey) return // DROP — encrypted data to Opus decoder = noise
  if (frame.data.byteLength < HEADER_SIZE + GCM_TAG_SIZE) return // Too short

  const iv = new Uint8Array(frame.data, 4, IV_SIZE)
  const ciphertext = new Uint8Array(frame.data, HEADER_SIZE)

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toAB(iv) },
    aesKey,
    toAB(ciphertext),
  ).then((decrypted) => {
    frame.data = decrypted
    controller.enqueue(frame)
  }).catch((err) => {
    console.error('[MediaCrypto:decrypt] Error:', err)
  })
}

// Exported for testing
export { writeUint32BE, readUint32BE, buildIV, encryptFrame, decryptFrame, HEADER_SIZE, GCM_TAG_SIZE }

interface StartTransformMessage {
  type: 'start-transform'
  direction: 'encrypt' | 'decrypt'
  readable: ReadableStream<{ data: ArrayBuffer }>
  writable: WritableStream<{ data: ArrayBuffer }>
}

interface SetKeyMessage {
  type: 'set-key'
  key: ArrayBuffer
}

type WorkerMessage = SetKeyMessage | StartTransformMessage

function startPipeline(
  direction: 'encrypt' | 'decrypt',
  readable: ReadableStream<{ data: ArrayBuffer }>,
  writable: WritableStream<{ data: ArrayBuffer }>,
): void {
  const transformFn = direction === 'encrypt' ? encryptFrame : decryptFrame
  console.log('[MediaCrypto] Pipeline starting, direction:', direction)
  let count = 0
  let keyAwaited = false
  const ts = new TransformStream<{ data: ArrayBuffer }, { data: ArrayBuffer }>({
    async transform(frame, controller) {
      if (!keyAwaited) {
        await keyReady
        keyAwaited = true
      }
      count++
      if (count === 1 || count % 500 === 0) {
        console.log(`[MediaCrypto:${direction}] frame #${count} size=${frame.data.byteLength} hasKey=${!!aesKey}`)
      }
      return transformFn(frame, controller)
    },
  })
  readable.pipeThrough(ts).pipeTo(writable).catch((err) => {
    console.error('[MediaCrypto] Pipeline error, direction:', direction, err)
  })
}

// Handle key delivery and stream setup via postMessage
self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerMessage
  if (msg.type === 'set-key' && msg.key) {
    keyReady = new Promise<void>((resolve) => { resolveKeyReady = resolve })
    aesKey = await crypto.subtle.importKey(
      'raw',
      msg.key,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
    if (resolveKeyReady) { resolveKeyReady(); resolveKeyReady = null }
  } else if (msg.type === 'start-transform') {
    startPipeline(msg.direction, msg.readable, msg.writable)
  }
}
