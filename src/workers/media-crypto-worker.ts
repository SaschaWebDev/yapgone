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

type FrameController = { enqueue: (frame: { data: ArrayBuffer }) => void }

function encryptFrame(frame: { data: ArrayBuffer }, controller: FrameController): void | Promise<void> {
  if (!aesKey) return // DROP — never send unencrypted audio
  const counter = frameCounter++
  const iv = buildIV(counter)
  const counterBytes = writeUint32BE(counter)

  const ivBuf = new ArrayBuffer(iv.byteLength)
  new Uint8Array(ivBuf).set(iv)
  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuf },
    aesKey,
    frame.data,
  ).then((encrypted) => {
    const output = new ArrayBuffer(HEADER_SIZE + encrypted.byteLength)
    const view = new Uint8Array(output)
    view.set(counterBytes, 0)
    view.set(iv, 4)
    view.set(new Uint8Array(encrypted), HEADER_SIZE)
    frame.data = output
    controller.enqueue(frame)
  }).catch((err) => {
    console.error('[MediaCrypto:encrypt] Error:', err)
  })
}

function decryptFrame(frame: { data: ArrayBuffer }, controller: FrameController): void | Promise<void> {
  if (!aesKey) return // DROP — encrypted data to Opus decoder = noise

  const frameData = new Uint8Array(frame.data)
  if (frameData.byteLength < HEADER_SIZE + GCM_TAG_SIZE) return // Too short

  const ivSlice = frameData.slice(4, 4 + IV_SIZE)
  const ivBuf = new ArrayBuffer(ivSlice.byteLength)
  new Uint8Array(ivBuf).set(ivSlice)
  const ciphertextSlice = frameData.slice(HEADER_SIZE)
  const ciphertextBuf = new ArrayBuffer(ciphertextSlice.byteLength)
  new Uint8Array(ciphertextBuf).set(ciphertextSlice)

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    aesKey,
    ciphertextBuf,
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
  const transform = direction === 'encrypt' ? encryptFrame : decryptFrame

  console.log('[MediaCrypto] Pipeline starting, direction:', direction)
  void (async () => {
    const reader = readable.getReader()
    const writer = writable.getWriter()
    let count = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        count++
        if (count === 1 || count % 500 === 0) {
          console.log(`[MediaCrypto:${direction}] frame #${count} size=${result.value.data.byteLength} hasKey=${!!aesKey}`)
        }
        let processed: { data: ArrayBuffer } | null = null
        const ctrl: FrameController = { enqueue: (f) => { processed = f as { data: ArrayBuffer } } }
        await transform(result.value, ctrl)
        if (processed) await writer.write(processed)
      }
      await writer.close()
    } catch (err) {
      console.error('[MediaCrypto] Pipeline error, direction:', direction, err)
    }
  })()
}

// Handle key delivery and stream setup via postMessage
self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerMessage
  if (msg.type === 'set-key' && msg.key) {
    aesKey = await crypto.subtle.importKey(
      'raw',
      msg.key,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  } else if (msg.type === 'start-transform') {
    startPipeline(msg.direction, msg.readable, msg.writable)
  }
}
