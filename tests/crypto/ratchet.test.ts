import { describe, it, expect } from 'vitest'
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfDerive,
} from '@/crypto'
import {
  initCreator,
  initJoiner,
  ratchetEncrypt,
  ratchetDecrypt,
  destroyState,
  _serializeHeader,
} from '@/crypto/ratchet'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function setupPair() {
  const aliceKp = await generateKeyPair()
  const bobKp = await generateKeyPair()

  const aliceSecret = await deriveSharedSecret(aliceKp.privateKey, bobKp.publicKey)
  const bobSecret = await deriveSharedSecret(bobKp.privateKey, aliceKp.publicKey)

  const salt = encoder.encode('yapgone-chat-root')
  const info = new Uint8Array(0)
  const aliceRootKey = await hkdfDerive(aliceSecret, salt, info, 32)
  const bobRootKey = await hkdfDerive(bobSecret, salt, info, 32)

  // Alice is creator, Bob is joiner
  const aliceState = await initCreator(aliceKp, aliceRootKey)
  const bobState = await initJoiner(bobKp, aliceKp.publicKey, bobRootKey)

  return { aliceState, bobState }
}

describe('ratchet', () => {
  it('initCreator produces valid state with null recvChainKey', async () => {
    const kp = await generateKeyPair()
    const rootKey = crypto.getRandomValues(new Uint8Array(32))
    const state = await initCreator(kp, rootKey)

    expect(state.dhKeyPair).toBe(kp)
    expect(state.remotePubKey).toBeNull()
    expect(state.sendChainKey).toHaveLength(32)
    expect(state.recvChainKey).toBeNull()
    expect(state.sendMessageNumber).toBe(0)
    expect(state.recvMessageNumber).toBe(0)
    expect(state.skippedMessageKeys.size).toBe(0)
  })

  it('initJoiner produces valid state with both chains set', async () => {
    const aliceKp = await generateKeyPair()
    const bobKp = await generateKeyPair()
    const rootKey = crypto.getRandomValues(new Uint8Array(32))
    const state = await initJoiner(bobKp, aliceKp.publicKey, rootKey)

    expect(state.remotePubKey).toBe(aliceKp.publicKey)
    expect(state.sendChainKey).toHaveLength(32)
    expect(state.recvChainKey).not.toBeNull()
    expect(state.recvChainKey).toHaveLength(32)
  })

  it('Bob sends, Alice decrypts (basic one-way)', async () => {
    const { aliceState, bobState } = await setupPair()

    const msg = encoder.encode('hello from bob')
    const { state: bobAfter, header, iv, ciphertext } = await ratchetEncrypt(bobState, msg)

    // Alice receives — triggers DH ratchet step since header pubkey differs
    const { state: aliceAfter, plaintext } = await ratchetDecrypt(aliceState, header, iv, ciphertext)

    expect(decoder.decode(plaintext)).toBe('hello from bob')
    expect(bobAfter.sendMessageNumber).toBe(1)
    expect(aliceAfter.recvMessageNumber).toBe(1)
  })

  it('bidirectional exchange works', async () => {
    let { aliceState, bobState } = await setupPair()

    // Bob -> Alice
    const msg1 = encoder.encode('hi alice')
    const enc1 = await ratchetEncrypt(bobState, msg1)
    bobState = enc1.state
    const dec1 = await ratchetDecrypt(aliceState, enc1.header, enc1.iv, enc1.ciphertext)
    aliceState = dec1.state
    expect(decoder.decode(dec1.plaintext)).toBe('hi alice')

    // Alice -> Bob
    const msg2 = encoder.encode('hi bob')
    const enc2 = await ratchetEncrypt(aliceState, msg2)
    aliceState = enc2.state
    const dec2 = await ratchetDecrypt(bobState, enc2.header, enc2.iv, enc2.ciphertext)
    bobState = dec2.state
    expect(decoder.decode(dec2.plaintext)).toBe('hi bob')

    // Bob -> Alice again
    const msg3 = encoder.encode('how are you?')
    const enc3 = await ratchetEncrypt(bobState, msg3)
    bobState = enc3.state
    const dec3 = await ratchetDecrypt(aliceState, enc3.header, enc3.iv, enc3.ciphertext)
    aliceState = dec3.state
    expect(decoder.decode(dec3.plaintext)).toBe('how are you?')
  })

  it('DH ratchet advances with new pubkey in header', async () => {
    let { aliceState, bobState } = await setupPair()

    // Bob sends
    const enc1 = await ratchetEncrypt(bobState, encoder.encode('msg1'))
    bobState = enc1.state
    const bobPubKey1 = enc1.header.pubkey

    const dec1 = await ratchetDecrypt(aliceState, enc1.header, enc1.iv, enc1.ciphertext)
    aliceState = dec1.state

    // Alice replies (triggers new DH key pair)
    const enc2 = await ratchetEncrypt(aliceState, encoder.encode('reply'))
    aliceState = enc2.state
    const alicePubKey1 = enc2.header.pubkey

    const dec2 = await ratchetDecrypt(bobState, enc2.header, enc2.iv, enc2.ciphertext)
    bobState = dec2.state

    // Bob replies again (new DH key pair)
    const enc3 = await ratchetEncrypt(bobState, encoder.encode('msg3'))
    bobState = enc3.state
    const bobPubKey2 = enc3.header.pubkey

    // Bob's pubkey changed after Alice replied
    expect(bobPubKey2).not.toBe(bobPubKey1)
    // Alice's pubkey was different from Bob's
    expect(alicePubKey1).not.toBe(bobPubKey1)
  })

  it('handles out-of-order messages', async () => {
    let { aliceState, bobState } = await setupPair()

    // Bob sends 3 messages
    const enc0 = await ratchetEncrypt(bobState, encoder.encode('msg0'))
    bobState = enc0.state
    const enc1 = await ratchetEncrypt(bobState, encoder.encode('msg1'))
    bobState = enc1.state
    const enc2 = await ratchetEncrypt(bobState, encoder.encode('msg2'))
    bobState = enc2.state

    // Alice receives msg2 first (skips 0 and 1)
    const dec2 = await ratchetDecrypt(aliceState, enc2.header, enc2.iv, enc2.ciphertext)
    aliceState = dec2.state
    expect(decoder.decode(dec2.plaintext)).toBe('msg2')

    // Alice receives msg0 (from skipped keys)
    const dec0 = await ratchetDecrypt(aliceState, enc0.header, enc0.iv, enc0.ciphertext)
    aliceState = dec0.state
    expect(decoder.decode(dec0.plaintext)).toBe('msg0')

    // Alice receives msg1 (from skipped keys)
    const dec1 = await ratchetDecrypt(aliceState, enc1.header, enc1.iv, enc1.ciphertext)
    aliceState = dec1.state
    expect(decoder.decode(dec1.plaintext)).toBe('msg1')
  })

  it('throws when too many messages are skipped', async () => {
    let { aliceState, bobState } = await setupPair()

    // Advance Bob's send counter past max skipped
    for (let i = 0; i < 101; i++) {
      const enc = await ratchetEncrypt(bobState, encoder.encode(`msg${i}`))
      bobState = enc.state
    }

    // Send one more
    const enc = await ratchetEncrypt(bobState, encoder.encode('final'))
    bobState = enc.state

    // Alice tries to decrypt the last one — should fail with too many skipped
    await expect(
      ratchetDecrypt(aliceState, enc.header, enc.iv, enc.ciphertext)
    ).rejects.toThrow('Too many skipped messages')
  })

  it('rejects tampered header (AAD integrity)', async () => {
    let { aliceState, bobState } = await setupPair()

    const enc = await ratchetEncrypt(bobState, encoder.encode('secret'))
    bobState = enc.state

    const tamperedHeader = { ...enc.header, n: 999 }

    await expect(
      ratchetDecrypt(aliceState, tamperedHeader, enc.iv, enc.ciphertext)
    ).rejects.toThrow()
  })

  it('handles multiple DH ratchet cycles', async () => {
    let { aliceState, bobState } = await setupPair()

    for (let i = 0; i < 5; i++) {
      // Bob -> Alice
      const encB = await ratchetEncrypt(bobState, encoder.encode(`bob-${i}`))
      bobState = encB.state
      const decB = await ratchetDecrypt(aliceState, encB.header, encB.iv, encB.ciphertext)
      aliceState = decB.state
      expect(decoder.decode(decB.plaintext)).toBe(`bob-${i}`)

      // Alice -> Bob
      const encA = await ratchetEncrypt(aliceState, encoder.encode(`alice-${i}`))
      aliceState = encA.state
      const decA = await ratchetDecrypt(bobState, encA.header, encA.iv, encA.ciphertext)
      bobState = decA.state
      expect(decoder.decode(decA.plaintext)).toBe(`alice-${i}`)
    }
  })

  it('destroyState zeroes key material', async () => {
    const { aliceState } = await setupPair()

    destroyState(aliceState)

    expect(aliceState.rootKey.every(b => b === 0)).toBe(true)
    expect(aliceState.sendChainKey.every(b => b === 0)).toBe(true)
    expect(aliceState.skippedMessageKeys.size).toBe(0)
  })

  it('serializeHeader is deterministic', () => {
    const header = { pubkey: 'abc123', n: 5, pn: 3 }
    const a = _serializeHeader(header)
    const b = _serializeHeader(header)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('multiple messages in same direction without reply', async () => {
    let { aliceState, bobState } = await setupPair()

    // Bob sends multiple without Alice replying
    const msgs = ['first', 'second', 'third']
    for (const text of msgs) {
      const enc = await ratchetEncrypt(bobState, encoder.encode(text))
      bobState = enc.state
      const dec = await ratchetDecrypt(aliceState, enc.header, enc.iv, enc.ciphertext)
      aliceState = dec.state
      expect(decoder.decode(dec.plaintext)).toBe(text)
    }
  })
})
