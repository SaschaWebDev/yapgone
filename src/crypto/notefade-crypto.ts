import { hkdfDerive } from './kdf'
import { encrypt, decrypt, importAesKey } from './encrypt'
import { toBase64Url, fromBase64Url, concatBytes } from './keys'

const SALT = new TextEncoder().encode('yapgone-notefade-salt')
const INFO = new TextEncoder().encode('yapgone-notefade-v1')

export const BYOK_DELIMITER = '!'

/** Derive the room-scoped notefade key and return it as base64url (for BYOK URL suffix). */
export async function deriveNotefadeKeyB64(roomId: string): Promise<string> {
  const ikm = new TextEncoder().encode(roomId)
  const keyBytes = await hkdfDerive(ikm, SALT, INFO, 32)
  const b64 = toBase64Url(keyBytes)
  keyBytes.fill(0)
  return b64
}

export async function encryptForNotefade(plaintext: string, roomId: string): Promise<string> {
  const ikm = new TextEncoder().encode(roomId)
  const keyBytes = await hkdfDerive(ikm, SALT, INFO, 32)
  const key = await importAesKey(keyBytes)
  const { iv, ciphertext } = await encrypt(new TextEncoder().encode(plaintext), key)
  return toBase64Url(concatBytes(iv, ciphertext))
}

export async function decryptFromNotefade(payload: string, roomId: string): Promise<string> {
  const raw = fromBase64Url(payload)
  const iv = raw.slice(0, 12)
  const ciphertext = raw.slice(12)
  const ikm = new TextEncoder().encode(roomId)
  const keyBytes = await hkdfDerive(ikm, SALT, INFO, 32)
  const key = await importAesKey(keyBytes)
  const plainBytes = await decrypt(ciphertext, iv, key)
  return new TextDecoder().decode(plainBytes)
}
