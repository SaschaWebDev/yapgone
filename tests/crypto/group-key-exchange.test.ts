import { describe, it, expect } from 'vitest'
import { generateKeyPair, exportPublicKey } from '../../src/crypto/ecdh'
import {
  initGroupMember,
  establishPairwiseRatchet,
  encryptSenderKeyForPeer,
  receiveSenderKeyFromPeer,
  handleMemberLeft,
  rekeyGroupMember,
  destroyGroupMemberCrypto,
} from '../../src/crypto/group-key-exchange'

describe('Group Key Exchange', () => {
  it('initializes group member state', async () => {
    const kp = await generateKeyPair()
    const state = await initGroupMember('alice-id', kp)

    expect(state.myId).toBe('alice-id')
    expect(state.myPubKeyRaw.length).toBe(65)
    expect(state.mySenderKey).toBeDefined()
    expect(state.pairwiseRatchets.size).toBe(0)
    expect(state.peerSenderKeys.size).toBe(0)
    expect(state.peerPubKeys.size).toBe(0)
  })

  it('establishes pairwise ratchet between two members', async () => {
    const kpAlice = await generateKeyPair()
    const kpBob = await generateKeyPair()
    const bobPubKeyRaw = await exportPublicKey(kpBob.publicKey)

    let alice = await initGroupMember('alice-id', kpAlice)
    const { state: updatedAlice } = await establishPairwiseRatchet(alice, 'bob-id', bobPubKeyRaw)
    alice = updatedAlice

    expect(alice.pairwiseRatchets.has('bob-id')).toBe(true)
    expect(alice.peerPubKeys.has('bob-id')).toBe(true)
  })

  it('distributes sender keys via pairwise ratchets', async () => {
    const kpAlice = await generateKeyPair()
    const kpBob = await generateKeyPair()
    const alicePubKeyRaw = await exportPublicKey(kpAlice.publicKey)
    const bobPubKeyRaw = await exportPublicKey(kpBob.publicKey)

    // Initialize both members
    let alice = await initGroupMember('alice-id', kpAlice)
    let bob = await initGroupMember('bob-id', kpBob)

    // Establish pairwise ratchets (alice is "creator" since her ID sorts first)
    const { state: updatedAlice } = await establishPairwiseRatchet(alice, 'bob-id', bobPubKeyRaw)
    alice = updatedAlice

    const { state: updatedBob } = await establishPairwiseRatchet(bob, 'alice-id', alicePubKeyRaw)
    bob = updatedBob

    // Alice sends her sender key to Bob
    const encResult = await encryptSenderKeyForPeer(alice, 'bob-id')
    expect(encResult).not.toBeNull()
    if (!encResult) return
    alice = encResult.state

    // Bob receives Alice's sender key
    const decResult = await receiveSenderKeyFromPeer(bob, 'alice-id', encResult.header, encResult.payload)
    expect(decResult).not.toBeNull()
    if (!decResult) return
    bob = decResult

    expect(bob.peerSenderKeys.has('alice-id')).toBe(true)
  })

  it('handles member leaving with rekey', async () => {
    const kpAlice = await generateKeyPair()
    const kpBob = await generateKeyPair()
    const bobPubKeyRaw = await exportPublicKey(kpBob.publicKey)

    let alice = await initGroupMember('alice-id', kpAlice)
    const { state: updatedAlice } = await establishPairwiseRatchet(alice, 'bob-id', bobPubKeyRaw)
    alice = updatedAlice

    // Bob leaves
    const afterLeave = await handleMemberLeft(alice, 'bob-id')

    expect(afterLeave.pairwiseRatchets.has('bob-id')).toBe(false)
    expect(afterLeave.peerSenderKeys.has('bob-id')).toBe(false)
    expect(afterLeave.peerPubKeys.has('bob-id')).toBe(false)
    // Sender key should be rekeyed (new chain key)
    expect(afterLeave.mySenderKey.messageNumber).toBe(0)
  })

  it('rekeys group member sender key', async () => {
    const kp = await generateKeyPair()
    let state = await initGroupMember('alice-id', kp)
    const oldChainKey = new Uint8Array(state.mySenderKey.chainKey)

    state = await rekeyGroupMember(state)

    expect(state.mySenderKey.messageNumber).toBe(0)
    // New chain key should be different
    const newChainKey = state.mySenderKey.chainKey
    let differs = false
    for (let i = 0; i < 32; i++) {
      if (oldChainKey[i] !== newChainKey[i]) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })

  it('destroys all crypto state', async () => {
    const kp = await generateKeyPair()
    const state = await initGroupMember('alice-id', kp)

    // Should not throw
    destroyGroupMemberCrypto(state)
    expect(state.mySenderKey.chainKey.every((b: number) => b === 0)).toBe(true)
  })

  it('supports 3-party key exchange', async () => {
    const kpAlice = await generateKeyPair()
    const kpBob = await generateKeyPair()
    const kpCharlie = await generateKeyPair()
    const alicePub = await exportPublicKey(kpAlice.publicKey)
    const bobPub = await exportPublicKey(kpBob.publicKey)
    const charliePub = await exportPublicKey(kpCharlie.publicKey)

    let alice = await initGroupMember('alice-id', kpAlice)
    let bob = await initGroupMember('bob-id', kpBob)
    let charlie = await initGroupMember('charlie-id', kpCharlie)

    // All pairwise ratchets
    const { state: a1 } = await establishPairwiseRatchet(alice, 'bob-id', bobPub)
    alice = a1
    const { state: a2 } = await establishPairwiseRatchet(alice, 'charlie-id', charliePub)
    alice = a2

    const { state: b1 } = await establishPairwiseRatchet(bob, 'alice-id', alicePub)
    bob = b1
    const { state: b2 } = await establishPairwiseRatchet(bob, 'charlie-id', charliePub)
    bob = b2

    const { state: c1 } = await establishPairwiseRatchet(charlie, 'alice-id', alicePub)
    charlie = c1
    const { state: c2 } = await establishPairwiseRatchet(charlie, 'bob-id', bobPub)
    charlie = c2

    expect(alice.pairwiseRatchets.size).toBe(2)
    expect(bob.pairwiseRatchets.size).toBe(2)
    expect(charlie.pairwiseRatchets.size).toBe(2)

    // Alice distributes her sender key to Bob
    const aliceToBob = await encryptSenderKeyForPeer(alice, 'bob-id')
    expect(aliceToBob).not.toBeNull()
    if (aliceToBob) {
      alice = aliceToBob.state
      const result = await receiveSenderKeyFromPeer(bob, 'alice-id', aliceToBob.header, aliceToBob.payload)
      if (result) bob = result
    }

    // Alice distributes her sender key to Charlie
    const aliceToCharlie = await encryptSenderKeyForPeer(alice, 'charlie-id')
    expect(aliceToCharlie).not.toBeNull()
    if (aliceToCharlie) {
      alice = aliceToCharlie.state
      const result = await receiveSenderKeyFromPeer(charlie, 'alice-id', aliceToCharlie.header, aliceToCharlie.payload)
      if (result) charlie = result
    }

    expect(bob.peerSenderKeys.has('alice-id')).toBe(true)
    expect(charlie.peerSenderKeys.has('alice-id')).toBe(true)
  })
})
