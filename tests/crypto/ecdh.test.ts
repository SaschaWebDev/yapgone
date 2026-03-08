import { describe, expect, it } from 'vitest'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedSecret } from '@/crypto'

describe('ECDH', () => {
  it('generates a key pair', async () => {
    const keyPair = await generateKeyPair()
    expect(keyPair.publicKey).toBeDefined()
    expect(keyPair.privateKey).toBeDefined()
  })

  it('exports a public key as 65 bytes (uncompressed P-256)', async () => {
    const keyPair = await generateKeyPair()
    const raw = await exportPublicKey(keyPair.publicKey)
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(0x04) // uncompressed point prefix
  })

  it('round-trips export/import of public key', async () => {
    const keyPair = await generateKeyPair()
    const exported = await exportPublicKey(keyPair.publicKey)
    const imported = await importPublicKey(exported)

    const reExported = await exportPublicKey(imported)
    expect(reExported).toEqual(exported)
  })

  it('derives the same shared secret on both sides', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()

    const aliceSecret = await deriveSharedSecret(alice.privateKey, bob.publicKey)
    const bobSecret = await deriveSharedSecret(bob.privateKey, alice.publicKey)

    expect(aliceSecret).toEqual(bobSecret)
    expect(aliceSecret.length).toBe(32)
  })

  it('derives different secrets with different key pairs', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const charlie = await generateKeyPair()

    const ab = await deriveSharedSecret(alice.privateKey, bob.publicKey)
    const ac = await deriveSharedSecret(alice.privateKey, charlie.publicKey)

    expect(ab).not.toEqual(ac)
  })
})
