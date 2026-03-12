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

var keyReady = Promise.resolve();
var resolveKeyReady = null;

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
  return crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    aesKey,
    frame.data
  ).then(function(encrypted) {
    var encView = new Uint8Array(encrypted);
    var output = new Uint8Array(HEADER_SIZE + encView.byteLength);
    output[0] = (counter >>> 24) & 0xff;
    output[1] = (counter >>> 16) & 0xff;
    output[2] = (counter >>> 8) & 0xff;
    output[3] = counter & 0xff;
    output.set(iv, 4);
    output.set(encView, HEADER_SIZE);
    frame.data = output.buffer;
    controller.enqueue(frame);
  }).catch(function(err) {
    console.error('[MediaCrypto:encrypt] Error:', err);
  });
}

function decryptFrame(frame, controller) {
  if (!aesKey) return; // DROP — encrypted data to Opus decoder = noise
  if (frame.data.byteLength < HEADER_SIZE + GCM_TAG_SIZE) return; // too short
  var iv = new Uint8Array(frame.data, 4, IV_SIZE);
  var ciphertext = new Uint8Array(frame.data, HEADER_SIZE);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    aesKey,
    ciphertext
  ).then(function(decrypted) {
    frame.data = decrypted;
    controller.enqueue(frame);
  }).catch(function(err) {
    console.error('[MediaCrypto:decrypt] Error:', err);
  });
}

function startPipeline(direction, readable, writable) {
  var transformFn = direction === 'encrypt' ? encryptFrame : decryptFrame;
  console.log('[MediaCrypto] Pipeline starting, direction:', direction);
  var count = 0;
  var keyAwaited = false;
  var ts = new TransformStream({
    transform: function(frame, controller) {
      if (!keyAwaited) {
        return keyReady.then(function() {
          keyAwaited = true;
          count++;
          if (count === 1 || count % 500 === 0) {
            console.log('[MediaCrypto:' + direction + '] frame #' + count +
              ' size=' + frame.data.byteLength + ' hasKey=' + !!aesKey);
          }
          return transformFn(frame, controller);
        });
      }
      count++;
      if (count === 1 || count % 500 === 0) {
        console.log('[MediaCrypto:' + direction + '] frame #' + count +
          ' size=' + frame.data.byteLength + ' hasKey=' + !!aesKey);
      }
      return transformFn(frame, controller);
    }
  });
  readable.pipeThrough(ts).pipeTo(writable).catch(function(err) {
    console.error('[MediaCrypto] Pipeline error, direction:', direction, err);
  });
}

self.onmessage = function(event) {
  var msg = event.data;
  if (msg.type === 'set-key' && msg.key) {
    keyReady = new Promise(function(resolve) { resolveKeyReady = resolve; });
    crypto.subtle.importKey(
      'raw', msg.key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    ).then(function(key) {
      aesKey = key;
      console.log('[MediaCrypto] Key imported via postMessage');
      if (resolveKeyReady) { resolveKeyReady(); resolveKeyReady = null; }
    }).catch(function() {
      if (resolveKeyReady) { resolveKeyReady(); resolveKeyReady = null; }
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
