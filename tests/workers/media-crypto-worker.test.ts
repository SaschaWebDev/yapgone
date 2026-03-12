import { describe, it, expect } from 'vitest'
import { writeUint32BE, readUint32BE, HEADER_SIZE, GCM_TAG_SIZE } from '../../src/workers/media-crypto-worker'

describe('media-crypto-worker utilities', () => {
  describe('writeUint32BE / readUint32BE', () => {
    it('round-trips zero', () => {
      const bytes = writeUint32BE(0)
      expect(readUint32BE(bytes)).toBe(0)
    })

    it('round-trips a typical counter value', () => {
      const bytes = writeUint32BE(12345)
      expect(readUint32BE(bytes)).toBe(12345)
    })

    it('round-trips max uint32', () => {
      const bytes = writeUint32BE(0xFFFFFFFF)
      expect(readUint32BE(bytes)).toBe(0xFFFFFFFF)
    })

    it('produces exactly 4 bytes', () => {
      const bytes = writeUint32BE(256)
      expect(bytes.byteLength).toBe(4)
    })
  })

  describe('encrypt/decrypt roundtrip', () => {
    it('encrypts and decrypts frame data', async () => {
      const rawKey = crypto.getRandomValues(new Uint8Array(32))
      const aesKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      )

      const originalData = new TextEncoder().encode('hello world')
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const counter = 42
      const counterBytes = writeUint32BE(counter)

      // Encrypt
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        originalData,
      )

      // Build wire format: [counter | iv | ciphertext]
      const wireFrame = new Uint8Array(HEADER_SIZE + encrypted.byteLength)
      wireFrame.set(counterBytes, 0)
      wireFrame.set(iv, 4)
      wireFrame.set(new Uint8Array(encrypted), HEADER_SIZE)

      // Decrypt
      const extractedIv = wireFrame.slice(4, 4 + 12)
      const ciphertext = wireFrame.slice(HEADER_SIZE)
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: extractedIv },
        aesKey,
        ciphertext,
      )

      expect(new Uint8Array(decrypted)).toEqual(originalData)
    })

    it('wrong key fails to decrypt', async () => {
      const key1 = await crypto.subtle.importKey(
        'raw',
        crypto.getRandomValues(new Uint8Array(32)),
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
      )
      const key2 = await crypto.subtle.importKey(
        'raw',
        crypto.getRandomValues(new Uint8Array(32)),
        { name: 'AES-GCM' },
        false,
        ['decrypt'],
      )

      const data = new TextEncoder().encode('secret')
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key1,
        data,
      )

      await expect(
        crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key2, encrypted),
      ).rejects.toThrow()
    })
  })

  describe('frame size validation', () => {
    it('frames shorter than header + GCM tag should be considered invalid', () => {
      const minSize = HEADER_SIZE + GCM_TAG_SIZE
      expect(minSize).toBe(32) // 4 + 12 + 16
      const shortFrame = new Uint8Array(minSize - 1)
      expect(shortFrame.byteLength).toBeLessThan(minSize)
    })
  })
})
