import { buf } from './buffer'

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    buf(raw),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encrypt(
  plaintext: Uint8Array,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const params: AesGcmParams = { name: 'AES-GCM', iv }
  if (aad) {
    params.additionalData = buf(aad)
  }

  const encrypted = await crypto.subtle.encrypt(params, key, buf(plaintext))
  return { iv, ciphertext: new Uint8Array(encrypted) }
}

export async function decrypt(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: buf(iv) }
  if (aad) {
    params.additionalData = buf(aad)
  }

  const decrypted = await crypto.subtle.decrypt(params, key, buf(ciphertext))
  return new Uint8Array(decrypted)
}
