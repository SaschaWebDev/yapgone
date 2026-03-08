import { describe, expect, it } from 'vitest'
import { encrypt, decrypt, importAesKey } from '@/crypto'

async function makeKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  return importAesKey(raw)
}

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trips plaintext', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('Hello, yapgone!')

    const { iv, ciphertext } = await encrypt(plaintext, key)
    const decrypted = await decrypt(ciphertext, iv, key)

    expect(new TextDecoder().decode(decrypted)).toBe('Hello, yapgone!')
  })

  it('produces different ciphertext each time (unique IV)', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('same message')

    const result1 = await encrypt(plaintext, key)
    const result2 = await encrypt(plaintext, key)

    expect(result1.iv).not.toEqual(result2.iv)
    expect(result1.ciphertext).not.toEqual(result2.ciphertext)
  })

  it('rejects tampered ciphertext', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('secret')

    const { iv, ciphertext } = await encrypt(plaintext, key)
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff

    await expect(decrypt(ciphertext, iv, key)).rejects.toThrow()
  })

  it('rejects tampered IV', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('secret')

    const { iv, ciphertext } = await encrypt(plaintext, key)
    iv[0] = (iv[0] ?? 0) ^ 0xff

    await expect(decrypt(ciphertext, iv, key)).rejects.toThrow()
  })

  it('supports AAD — verifies additional data', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('message')
    const aad = new TextEncoder().encode('header-data')

    const { iv, ciphertext } = await encrypt(plaintext, key, aad)

    // Decrypt with correct AAD
    const decrypted = await decrypt(ciphertext, iv, key, aad)
    expect(new TextDecoder().decode(decrypted)).toBe('message')

    // Decrypt with wrong AAD should fail
    const wrongAad = new TextEncoder().encode('wrong-header')
    await expect(decrypt(ciphertext, iv, key, wrongAad)).rejects.toThrow()
  })

  it('fails without AAD when encrypted with AAD', async () => {
    const key = await makeKey()
    const plaintext = new TextEncoder().encode('message')
    const aad = new TextEncoder().encode('header-data')

    const { iv, ciphertext } = await encrypt(plaintext, key, aad)

    // Decrypt without AAD should fail
    await expect(decrypt(ciphertext, iv, key)).rejects.toThrow()
  })
})
