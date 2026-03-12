import { describe, it, expect } from 'vitest'
import { deriveMediaKeyRaw } from '../../src/crypto/media-key'

describe('deriveMediaKeyRaw', () => {
  it('returns 32 bytes', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32))
    const mediaKey = await deriveMediaKeyRaw(rootKey)
    expect(mediaKey).toBeInstanceOf(Uint8Array)
    expect(mediaKey.byteLength).toBe(32)
  })

  it('is deterministic — same rootKey produces same media key', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32))
    const key1 = await deriveMediaKeyRaw(rootKey)
    const key2 = await deriveMediaKeyRaw(rootKey)
    expect(key1).toEqual(key2)
  })

  it('different rootKeys produce different media keys', async () => {
    const rootKey1 = crypto.getRandomValues(new Uint8Array(32))
    const rootKey2 = crypto.getRandomValues(new Uint8Array(32))
    const key1 = await deriveMediaKeyRaw(rootKey1)
    const key2 = await deriveMediaKeyRaw(rootKey2)
    expect(key1).not.toEqual(key2)
  })

  it('does not mutate the rootKey', async () => {
    const rootKey = crypto.getRandomValues(new Uint8Array(32))
    const original = new Uint8Array(rootKey)
    await deriveMediaKeyRaw(rootKey)
    expect(rootKey).toEqual(original)
  })
})
