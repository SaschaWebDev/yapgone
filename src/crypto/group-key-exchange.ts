import { exportPublicKey, importPublicKey, deriveSharedSecret } from './ecdh'
import { hkdfDerive } from './kdf'
import { initCreator as initRatchetCreator, initJoiner as initRatchetJoiner, ratchetEncrypt, ratchetDecrypt } from './ratchet'
import { toBase64Url, fromBase64Url } from './keys'
import type { RatchetState } from '@/types'
import { generateSenderKey, exportSenderKeyForDistribution, importReceivedSenderKey, destroySenderKeyState, destroyReceivedSenderKey } from './sender-keys'
import type { SenderKeyState, ReceivedSenderKey } from './sender-keys'

const SALT = new TextEncoder().encode('yapgone-chat-root')
const INFO = new Uint8Array(0)

/**
 * State for a group member's crypto context.
 */
export interface GroupMemberCrypto {
  myId: string
  myKeyPair: CryptoKeyPair
  myPubKeyRaw: Uint8Array
  mySenderKey: SenderKeyState
  /** Pairwise ratchets keyed by peer clientId */
  pairwiseRatchets: Map<string, RatchetState>
  /** Received sender keys keyed by peer clientId */
  peerSenderKeys: Map<string, ReceivedSenderKey>
  /** Peer public keys keyed by clientId */
  peerPubKeys: Map<string, Uint8Array>
}

/**
 * Initialize group crypto state for the local member.
 */
export async function initGroupMember(
  myId: string,
  keyPair: CryptoKeyPair,
): Promise<GroupMemberCrypto> {
  const myPubKeyRaw = await exportPublicKey(keyPair.publicKey)
  const senderKey = await generateSenderKey()
  return {
    myId,
    myKeyPair: keyPair,
    myPubKeyRaw,
    mySenderKey: senderKey,
    pairwiseRatchets: new Map(),
    peerSenderKeys: new Map(),
    peerPubKeys: new Map(),
  }
}

/**
 * Establish a pairwise ratchet with a peer.
 * `isInitiator` should be true if our clientId sorts before the peer's.
 */
export async function establishPairwiseRatchet(
  state: GroupMemberCrypto,
  peerId: string,
  peerPubKeyRaw: Uint8Array,
): Promise<{ state: GroupMemberCrypto; ratchet: RatchetState }> {
  const peerPubKey = await importPublicKey(peerPubKeyRaw)
  const sharedSecret = await deriveSharedSecret(state.myKeyPair.privateKey, peerPubKey)
  const rootKey = await hkdfDerive(sharedSecret, SALT, INFO, 32)

  // Deterministic role: lower clientId is "creator" (initiator)
  const isInitiator = state.myId < peerId

  let ratchet: RatchetState
  if (isInitiator) {
    ratchet = await initRatchetCreator(state.myKeyPair, rootKey)
  } else {
    ratchet = await initRatchetJoiner(state.myKeyPair, peerPubKey, rootKey)
  }

  const newPairwise = new Map(state.pairwiseRatchets)
  newPairwise.set(peerId, ratchet)

  const newPeerPubKeys = new Map(state.peerPubKeys)
  newPeerPubKeys.set(peerId, peerPubKeyRaw)

  return {
    state: { ...state, pairwiseRatchets: newPairwise, peerPubKeys: newPeerPubKeys },
    ratchet,
  }
}

/**
 * Serialize our sender key for pairwise-encrypted distribution to a peer.
 * Returns the ratchet-encrypted payload ready to send as a 'direct' message.
 */
export async function encryptSenderKeyForPeer(
  state: GroupMemberCrypto,
  peerId: string,
): Promise<{
  state: GroupMemberCrypto
  header: { pubkey: string; n: number; pn: number }
  payload: string
} | null> {
  const ratchet = state.pairwiseRatchets.get(peerId)
  if (!ratchet) return null

  const exported = await exportSenderKeyForDistribution(state.mySenderKey)
  const distribution = {
    kind: 'sender-key-distribution' as const,
    senderId: state.myId,
    verifyingKey: toBase64Url(exported.verifyingKeyRaw),
    chainKey: toBase64Url(exported.chainKey),
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(distribution))
  const { state: newRatchet, header, iv, ciphertext } = await ratchetEncrypt(ratchet, plaintext)

  const newPairwise = new Map(state.pairwiseRatchets)
  newPairwise.set(peerId, newRatchet)

  const payloadBytes = new Uint8Array(iv.length + ciphertext.length)
  payloadBytes.set(iv)
  payloadBytes.set(ciphertext, iv.length)

  return {
    state: { ...state, pairwiseRatchets: newPairwise },
    header,
    payload: toBase64Url(payloadBytes),
  }
}

/**
 * Receive and decrypt a sender key distribution from a peer via pairwise ratchet.
 */
export async function receiveSenderKeyFromPeer(
  state: GroupMemberCrypto,
  peerId: string,
  header: { pubkey: string; n: number; pn: number },
  payload: string,
): Promise<GroupMemberCrypto | null> {
  const ratchet = state.pairwiseRatchets.get(peerId)
  if (!ratchet) return null

  const payloadBytes = fromBase64Url(payload)
  const iv = payloadBytes.slice(0, 12)
  const ciphertext = payloadBytes.slice(12)

  const { state: newRatchet, plaintext } = await ratchetDecrypt(ratchet, header, iv, ciphertext)

  const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext))
  if (
    typeof decoded !== 'object' || decoded === null ||
    (decoded as Record<string, unknown>).kind !== 'sender-key-distribution'
  ) {
    return null
  }

  const dist = decoded as {
    kind: 'sender-key-distribution'
    senderId: string
    verifyingKey: string
    chainKey: string
  }

  const verifyingKeyRaw = fromBase64Url(dist.verifyingKey)
  const chainKey = fromBase64Url(dist.chainKey)
  const received = await importReceivedSenderKey(verifyingKeyRaw, chainKey)

  const newPairwise = new Map(state.pairwiseRatchets)
  newPairwise.set(peerId, newRatchet)

  const newPeerSenderKeys = new Map(state.peerSenderKeys)
  // Destroy old sender key if exists
  const oldKey = newPeerSenderKeys.get(dist.senderId)
  if (oldKey) destroyReceivedSenderKey(oldKey)
  newPeerSenderKeys.set(dist.senderId, received)

  return {
    ...state,
    pairwiseRatchets: newPairwise,
    peerSenderKeys: newPeerSenderKeys,
  }
}

/**
 * Rekey: generate a new sender key and return the new state.
 * Caller must distribute the new sender key to all peers via pairwise channels.
 */
export async function rekeyGroupMember(
  state: GroupMemberCrypto,
): Promise<GroupMemberCrypto> {
  destroySenderKeyState(state.mySenderKey)
  const newSenderKey = await generateSenderKey()
  return { ...state, mySenderKey: newSenderKey }
}

/**
 * Handle a member leaving: remove their pairwise ratchet and sender key,
 * then rekey our own sender key.
 */
export async function handleMemberLeft(
  state: GroupMemberCrypto,
  peerId: string,
): Promise<GroupMemberCrypto> {
  const newPairwise = new Map(state.pairwiseRatchets)
  newPairwise.delete(peerId)

  const newPeerSenderKeys = new Map(state.peerSenderKeys)
  const oldKey = newPeerSenderKeys.get(peerId)
  if (oldKey) destroyReceivedSenderKey(oldKey)
  newPeerSenderKeys.delete(peerId)

  const newPeerPubKeys = new Map(state.peerPubKeys)
  newPeerPubKeys.delete(peerId)

  let updated = {
    ...state,
    pairwiseRatchets: newPairwise,
    peerSenderKeys: newPeerSenderKeys,
    peerPubKeys: newPeerPubKeys,
  }

  // Rekey to ensure departed member can't decrypt future messages
  updated = await rekeyGroupMember(updated)

  return updated
}

/**
 * Destroy all crypto state for cleanup.
 */
export function destroyGroupMemberCrypto(state: GroupMemberCrypto): void {
  destroySenderKeyState(state.mySenderKey)
  for (const [, received] of state.peerSenderKeys) {
    destroyReceivedSenderKey(received)
  }
  // Pairwise ratchets will be cleaned up by destroyState from ratchet.ts
  // by the caller if needed
}
