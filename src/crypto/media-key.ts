import { hkdfDerive } from './kdf'

const MEDIA_SALT = new TextEncoder().encode('yapgone-media-key')
const MEDIA_INFO = new TextEncoder().encode('aes-256-gcm-media')

export async function deriveMediaKeyRaw(rootKey: Uint8Array): Promise<Uint8Array> {
  return hkdfDerive(rootKey, MEDIA_SALT, MEDIA_INFO, 32)
}
