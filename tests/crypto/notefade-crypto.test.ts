import { describe, expect, it } from 'vitest'
import { encryptForNotefade, decryptFromNotefade, deriveNotefadeKeyB64, fromBase64Url, importAesKey, decrypt } from '@/crypto'

describe('notefade crypto (room-ID encryption)', () => {
  it('round-trips plaintext with the same roomId', async () => {
    const roomId = crypto.randomUUID()
    const plaintext = 'This is a secret note for the chat.'

    const encrypted = await encryptForNotefade(plaintext, roomId)
    const decrypted = await decryptFromNotefade(encrypted, roomId)

    expect(decrypted).toBe(plaintext)
  })

  it('produces different ciphertext each time (unique IV)', async () => {
    const roomId = crypto.randomUUID()
    const plaintext = 'same secret'

    const a = await encryptForNotefade(plaintext, roomId)
    const b = await encryptForNotefade(plaintext, roomId)

    expect(a).not.toBe(b)
  })

  it('fails to decrypt with a different roomId', async () => {
    const roomIdA = crypto.randomUUID()
    const roomIdB = crypto.randomUUID()

    const encrypted = await encryptForNotefade('secret', roomIdA)

    await expect(decryptFromNotefade(encrypted, roomIdB)).rejects.toThrow()
  })

  it('handles empty string', async () => {
    const roomId = crypto.randomUUID()

    const encrypted = await encryptForNotefade('', roomId)
    const decrypted = await decryptFromNotefade(encrypted, roomId)

    expect(decrypted).toBe('')
  })

  it('handles unicode content', async () => {
    const roomId = crypto.randomUUID()
    const text = 'Hello world \u{1F30D} \u00E9\u00E8\u00EA \u4F60\u597D'

    const encrypted = await encryptForNotefade(text, roomId)
    const decrypted = await decryptFromNotefade(encrypted, roomId)

    expect(decrypted).toBe(text)
  })
})

describe('BYOK (roomId-derived key)', () => {
  it('derived key decodes to exactly 32 bytes', async () => {
    const keyB64 = await deriveNotefadeKeyB64(crypto.randomUUID())
    expect(fromBase64Url(keyB64).length).toBe(32)
  })

  it('same roomId produces the same key (deterministic)', async () => {
    const roomId = crypto.randomUUID()
    const a = await deriveNotefadeKeyB64(roomId)
    const b = await deriveNotefadeKeyB64(roomId)
    expect(a).toBe(b)
  })

  it('different roomIds produce different keys', async () => {
    const a = await deriveNotefadeKeyB64(crypto.randomUUID())
    const b = await deriveNotefadeKeyB64(crypto.randomUUID())
    expect(a).not.toBe(b)
  })

  it('derived key can decrypt encryptForNotefade output', async () => {
    const roomId = crypto.randomUUID()
    const plaintext = 'This is a BYOK secret note.'

    const encrypted = await encryptForNotefade(plaintext, roomId)
    const keyB64 = await deriveNotefadeKeyB64(roomId)

    const raw = fromBase64Url(encrypted)
    const iv = raw.slice(0, 12)
    const ciphertext = raw.slice(12)
    const cryptoKey = await importAesKey(fromBase64Url(keyB64))
    const decrypted = await decrypt(ciphertext, iv, cryptoKey)

    expect(new TextDecoder().decode(decrypted)).toBe(plaintext)
  })

  it('encrypted blob matches BYOK format: IV (12) + ciphertext + GCM tag (16)', async () => {
    const roomId = crypto.randomUUID()
    const plaintext = 'hello'
    const plaintextBytes = new TextEncoder().encode(plaintext).length

    const encrypted = await encryptForNotefade(plaintext, roomId)
    const raw = fromBase64Url(encrypted)

    expect(raw.length).toBe(12 + plaintextBytes + 16)
  })

  it('wrong roomId key fails to decrypt', async () => {
    const encrypted = await encryptForNotefade('secret', crypto.randomUUID())
    const wrongKeyB64 = await deriveNotefadeKeyB64(crypto.randomUUID())

    const raw = fromBase64Url(encrypted)
    const iv = raw.slice(0, 12)
    const ciphertext = raw.slice(12)
    const cryptoKey = await importAesKey(fromBase64Url(wrongKeyB64))

    await expect(decrypt(ciphertext, iv, cryptoKey)).rejects.toThrow()
  })
})
