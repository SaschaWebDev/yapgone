import { describe, expect, it } from 'vitest'
import { encryptForNotefade, decryptFromNotefade } from '@/crypto'

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
