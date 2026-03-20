import { describe, it, expect } from 'vitest'
import {
  generateSenderKey,
  exportSenderKeyForDistribution,
  importReceivedSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  destroySenderKeyState,
  destroyReceivedSenderKey,
} from '../../src/crypto/sender-keys'

describe('Sender Keys', () => {
  it('generates a sender key with ECDSA signing pair and 32-byte chain key', async () => {
    const state = await generateSenderKey()
    expect(state.signingKeyPair.publicKey).toBeDefined()
    expect(state.signingKeyPair.privateKey).toBeDefined()
    expect(state.chainKey.length).toBe(32)
    expect(state.messageNumber).toBe(0)
  })

  it('exports and imports a sender key for distribution', async () => {
    const state = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(state)

    expect(exported.verifyingKeyRaw.length).toBe(65) // P-256 raw public key
    expect(exported.chainKey.length).toBe(32)

    const received = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)
    expect(received.verifyingKey).toBeDefined()
    expect(received.chainKey.length).toBe(32)
    expect(received.nextMessageNumber).toBe(0)
    expect(received.skippedKeys.size).toBe(0)
  })

  it('encrypts and decrypts a message', async () => {
    const senderState = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(senderState)
    const receiverState = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)

    const plaintext = new TextEncoder().encode('hello group')
    const result = await senderKeyEncrypt(senderState, plaintext)

    expect(result.messageNumber).toBe(0)
    expect(result.iv.length).toBe(12)
    expect(result.ciphertext.length).toBeGreaterThan(0)
    expect(result.signature.length).toBeGreaterThan(0)
    expect(result.state.messageNumber).toBe(1)

    const decrypted = await senderKeyDecrypt(
      receiverState,
      result.messageNumber,
      result.iv,
      result.ciphertext,
      result.signature,
    )

    expect(new TextDecoder().decode(decrypted.plaintext)).toBe('hello group')
    expect(decrypted.received.nextMessageNumber).toBe(1)
  })

  it('advances chain key with each message', async () => {
    let state = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(state)
    let received = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)

    for (let i = 0; i < 5; i++) {
      const plaintext = new TextEncoder().encode(`message ${i}`)
      const result = await senderKeyEncrypt(state, plaintext)
      expect(result.messageNumber).toBe(i)
      state = result.state

      const decrypted = await senderKeyDecrypt(
        received,
        result.messageNumber,
        result.iv,
        result.ciphertext,
        result.signature,
      )
      expect(new TextDecoder().decode(decrypted.plaintext)).toBe(`message ${i}`)
      received = decrypted.received
    }
  })

  it('handles out-of-order delivery', async () => {
    let state = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(state)
    let received = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)

    // Encrypt 3 messages
    const encrypted = []
    for (let i = 0; i < 3; i++) {
      const result = await senderKeyEncrypt(state, new TextEncoder().encode(`msg-${i}`))
      encrypted.push(result)
      state = result.state
    }

    // Decrypt in reverse order (msg-2, msg-1, msg-0)
    // First: decrypt msg-2 (skips 0 and 1)
    const r2 = await senderKeyDecrypt(
      received,
      encrypted[2]!.messageNumber,
      encrypted[2]!.iv,
      encrypted[2]!.ciphertext,
      encrypted[2]!.signature,
    )
    expect(new TextDecoder().decode(r2.plaintext)).toBe('msg-2')
    expect(r2.received.skippedKeys.size).toBe(2)
    received = r2.received

    // Then decrypt msg-0 (from skipped keys)
    const r0 = await senderKeyDecrypt(
      received,
      encrypted[0]!.messageNumber,
      encrypted[0]!.iv,
      encrypted[0]!.ciphertext,
      encrypted[0]!.signature,
    )
    expect(new TextDecoder().decode(r0.plaintext)).toBe('msg-0')
    expect(r0.received.skippedKeys.size).toBe(1)
    received = r0.received

    // Then decrypt msg-1 (from skipped keys)
    const r1 = await senderKeyDecrypt(
      received,
      encrypted[1]!.messageNumber,
      encrypted[1]!.iv,
      encrypted[1]!.ciphertext,
      encrypted[1]!.signature,
    )
    expect(new TextDecoder().decode(r1.plaintext)).toBe('msg-1')
    expect(r1.received.skippedKeys.size).toBe(0)
  })

  it('rejects messages with invalid signature', async () => {
    const senderState = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(senderState)
    const receiverState = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)

    const plaintext = new TextEncoder().encode('tampered')
    const result = await senderKeyEncrypt(senderState, plaintext)

    // Tamper with the signature
    const badSig = new Uint8Array(result.signature)
    badSig[0] = (badSig[0] ?? 0) ^ 0xff

    await expect(
      senderKeyDecrypt(receiverState, result.messageNumber, result.iv, result.ciphertext, badSig),
    ).rejects.toThrow('Invalid sender key signature')
  })

  it('rejects messages from wrong sender', async () => {
    const sender1 = await generateSenderKey()
    const sender2 = await generateSenderKey()
    const exported1 = await exportSenderKeyForDistribution(sender1)
    const receiverState = await importReceivedSenderKey(exported1.verifyingKeyRaw, exported1.chainKey)

    // Encrypt with sender2, try to decrypt with sender1's receiver
    const plaintext = new TextEncoder().encode('wrong sender')
    const result = await senderKeyEncrypt(sender2, plaintext)

    await expect(
      senderKeyDecrypt(receiverState, result.messageNumber, result.iv, result.ciphertext, result.signature),
    ).rejects.toThrow('Invalid sender key signature')
  })

  it('destroys sender key state', async () => {
    const state = await generateSenderKey()
    destroySenderKeyState(state)
    expect(state.chainKey.every(b => b === 0)).toBe(true)
  })

  it('old receiver cannot decrypt messages from rekeyed sender', async () => {
    // Step 1: Generate sender key, create receiver
    const sender1 = await generateSenderKey()
    const exported1 = await exportSenderKeyForDistribution(sender1)
    const receiver1 = await importReceivedSenderKey(exported1.verifyingKeyRaw, exported1.chainKey)

    // Step 2: First message succeeds
    const msg1 = await senderKeyEncrypt(sender1, new TextEncoder().encode('before rekey'))
    const dec1 = await senderKeyDecrypt(
      receiver1,
      msg1.messageNumber,
      msg1.iv,
      msg1.ciphertext,
      msg1.signature,
    )
    expect(new TextDecoder().decode(dec1.plaintext)).toBe('before rekey')

    // Step 3: Rekey — generate a completely new sender key (simulates rekey on member leave)
    const sender2 = await generateSenderKey()
    const exported2 = await exportSenderKeyForDistribution(sender2)

    // Step 4: New receiver works with new key
    const receiver2 = await importReceivedSenderKey(exported2.verifyingKeyRaw, exported2.chainKey)
    const msg2 = await senderKeyEncrypt(sender2, new TextEncoder().encode('after rekey'))
    const dec2 = await senderKeyDecrypt(
      receiver2,
      msg2.messageNumber,
      msg2.iv,
      msg2.ciphertext,
      msg2.signature,
    )
    expect(new TextDecoder().decode(dec2.plaintext)).toBe('after rekey')

    // Step 5: Old receiver CANNOT decrypt new sender's messages (wrong signing key + wrong chain)
    await expect(
      senderKeyDecrypt(
        dec1.received,
        msg2.messageNumber,
        msg2.iv,
        msg2.ciphertext,
        msg2.signature,
      ),
    ).rejects.toThrow()
  })

  it('destroys received sender key state', async () => {
    const state = await generateSenderKey()
    const exported = await exportSenderKeyForDistribution(state)
    const received = await importReceivedSenderKey(exported.verifyingKeyRaw, exported.chainKey)

    // Add a skipped key
    await senderKeyEncrypt(state, new TextEncoder().encode('skip'))
    // Force a skip by decrypting message 0 after setting nextMessageNumber artificially
    // Just test the destroy function
    destroyReceivedSenderKey(received)
    expect(received.chainKey.every(b => b === 0)).toBe(true)
  })
})
