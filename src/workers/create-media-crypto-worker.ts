/**
 * Creates a media crypto worker via Blob URL to bypass Vite's module worker
 * bundling. Uses Insertable Streams API (createEncodedStreams) — streams are
 * transferred from the main thread via postMessage instead of relying on the
 * rtctransform event (which silently fails on receivers in some browsers).
 *
 * The embedded JavaScript is intentionally plain — no TypeScript, no imports,
 * no module syntax. See `media-crypto-worker.ts` for a type-checked reference.
 */

const WORKER_SOURCE = /* js */ `
'use strict';
console.log('[MediaCrypto] Worker created');

var HEADER_SIZE = 4 + 12;
var GCM_TAG_SIZE = 16;
var IV_SIZE = 12;

var aesKey = null;
var frameCounter = 0;
var sessionSalt = crypto.getRandomValues(new Uint8Array(4));

function writeUint32BE(value) {
  var b = new Uint8Array(4);
  b[0] = (value >>> 24) & 0xff;
  b[1] = (value >>> 16) & 0xff;
  b[2] = (value >>> 8) & 0xff;
  b[3] = value & 0xff;
  return b;
}

function buildIV(counter) {
  var iv = new Uint8Array(IV_SIZE);
  iv.set(sessionSalt, 0);
  var counterBytes = writeUint32BE(counter);
  iv.set(counterBytes, 8);
  return iv;
}

function encryptFrame(frame, controller) {
  if (!aesKey) return; // DROP — never send unencrypted audio
  var counter = frameCounter++;
  var iv = buildIV(counter);
  var counterBytes = writeUint32BE(counter);
  var ivBuf = new ArrayBuffer(iv.byteLength);
  new Uint8Array(ivBuf).set(iv);
  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuf },
    aesKey,
    frame.data
  ).then(function(encrypted) {
    var output = new ArrayBuffer(HEADER_SIZE + encrypted.byteLength);
    var view = new Uint8Array(output);
    view.set(counterBytes, 0);
    view.set(iv, 4);
    view.set(new Uint8Array(encrypted), HEADER_SIZE);
    frame.data = output;
    controller.enqueue(frame);
  }).catch(function(err) {
    console.error('[MediaCrypto:encrypt] Error:', err);
  });
}

function decryptFrame(frame, controller) {
  if (!aesKey) return; // DROP — encrypted data to Opus decoder = noise
  var frameData = new Uint8Array(frame.data);
  if (frameData.byteLength < HEADER_SIZE + GCM_TAG_SIZE) return; // too short
  var ivSlice = frameData.slice(4, 4 + IV_SIZE);
  var ivBuf = new ArrayBuffer(ivSlice.byteLength);
  new Uint8Array(ivBuf).set(ivSlice);
  var ciphertextSlice = frameData.slice(HEADER_SIZE);
  var ciphertextBuf = new ArrayBuffer(ciphertextSlice.byteLength);
  new Uint8Array(ciphertextBuf).set(ciphertextSlice);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    aesKey,
    ciphertextBuf
  ).then(function(decrypted) {
    frame.data = decrypted;
    controller.enqueue(frame);
  }).catch(function(err) {
    console.error('[MediaCrypto:decrypt] Error:', err);
  });
}

function startPipeline(direction, readable, writable) {
  var transform = direction === 'encrypt' ? encryptFrame : decryptFrame;
  console.log('[MediaCrypto] Pipeline starting, direction:', direction);
  (async function() {
    var reader = readable.getReader();
    var writer = writable.getWriter();
    var count = 0;
    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        count++;
        if (count === 1 || count % 500 === 0) {
          console.log('[MediaCrypto:' + direction + '] frame #' + count +
            ' size=' + result.value.data.byteLength + ' hasKey=' + !!aesKey);
        }
        var processed = null;
        var ctrl = { enqueue: function(f) { processed = f; } };
        await transform(result.value, ctrl);
        if (processed) await writer.write(processed);
      }
      await writer.close();
    } catch (err) {
      console.error('[MediaCrypto] Pipeline error, direction:', direction, err);
    }
  })();
}

self.onmessage = function(event) {
  var msg = event.data;
  if (msg.type === 'set-key' && msg.key) {
    crypto.subtle.importKey(
      'raw', msg.key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    ).then(function(key) {
      aesKey = key;
      console.log('[MediaCrypto] Key imported via postMessage');
    }).catch(function() {
      // Key import failed
    });
  } else if (msg.type === 'start-transform') {
    startPipeline(msg.direction, msg.readable, msg.writable);
  }
};
`;

export function createMediaCryptoWorker(): { worker: Worker; cleanup: () => void } {
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  const worker = new Worker(url)

  function cleanup() {
    worker.terminate()
    URL.revokeObjectURL(url)
  }

  return { worker, cleanup }
}
