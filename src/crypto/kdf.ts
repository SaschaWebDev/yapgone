import { buf } from './buffer'

export async function hkdfDerive(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    buf(ikm),
    'HKDF',
    false,
    ['deriveBits']
  )

  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    baseKey,
    length * 8
  )

  return new Uint8Array(derived)
}

async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    buf(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

export async function hmacSign(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importHmacKey(key)
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, buf(data))
  return new Uint8Array(signature)
}

export async function kdfRatchetStep(
  chainKey: Uint8Array,
): Promise<{ nextChainKey: Uint8Array; messageKey: Uint8Array }> {
  const nextChainKey = await hmacSign(chainKey, new Uint8Array([0x01]))
  const messageKey = await hmacSign(chainKey, new Uint8Array([0x02]))
  return { nextChainKey, messageKey }
}
