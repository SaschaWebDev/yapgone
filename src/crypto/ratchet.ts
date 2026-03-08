import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedSecret } from './ecdh'
import { encrypt, decrypt, importAesKey } from './encrypt'
import { hkdfDerive, kdfRatchetStep } from './kdf'
import { toBase64Url, fromBase64Url } from './keys'
import type { RatchetState } from '@/types'
import type { MessageHeader } from '@/ws/protocol'
import { MAX_SKIPPED_KEYS } from '@/constants'

const RATCHET_INFO = new TextEncoder().encode('yapgone-ratchet')

export async function initCreator(
  dhKeyPair: CryptoKeyPair,
  rootKey: Uint8Array,
): Promise<RatchetState> {
  const derived = await hkdfDerive(rootKey, rootKey, RATCHET_INFO, 64)
  const newRootKey = derived.slice(0, 32)
  const sendChainKey = derived.slice(32, 64)

  return {
    dhKeyPair,
    remotePubKey: null,
    rootKey: newRootKey,
    sendChainKey,
    sendMessageNumber: 0,
    recvChainKey: null,
    recvMessageNumber: 0,
    prevSendChainLength: 0,
    skippedMessageKeys: new Map(),
  }
}

export async function initJoiner(
  dhKeyPair: CryptoKeyPair,
  remotePubKey: CryptoKey,
  rootKey: Uint8Array,
): Promise<RatchetState> {
  // Derive recv chain from initial root key
  const recvDerived = await hkdfDerive(rootKey, rootKey, RATCHET_INFO, 64)
  const intermediateRootKey = recvDerived.slice(0, 32)
  const recvChainKey = recvDerived.slice(32, 64)

  // DH ratchet step for send chain
  const dhOutput = await deriveSharedSecret(dhKeyPair.privateKey, remotePubKey)
  const sendDerived = await hkdfDerive(dhOutput, intermediateRootKey, RATCHET_INFO, 64)
  const newRootKey = sendDerived.slice(0, 32)
  const sendChainKey = sendDerived.slice(32, 64)

  return {
    dhKeyPair,
    remotePubKey,
    rootKey: newRootKey,
    sendChainKey,
    sendMessageNumber: 0,
    recvChainKey,
    recvMessageNumber: 0,
    prevSendChainLength: 0,
    skippedMessageKeys: new Map(),
  }
}

function serializeHeader(header: MessageHeader): Uint8Array {
  const json = JSON.stringify({ pubkey: header.pubkey, n: header.n, pn: header.pn })
  return new TextEncoder().encode(json)
}

export async function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
): Promise<{ state: RatchetState; header: MessageHeader; iv: Uint8Array; ciphertext: Uint8Array }> {
  const { nextChainKey, messageKey } = await kdfRatchetStep(state.sendChainKey)
  const pubKeyRaw = await exportPublicKey(state.dhKeyPair.publicKey)

  const header: MessageHeader = {
    pubkey: toBase64Url(pubKeyRaw),
    n: state.sendMessageNumber,
    pn: state.prevSendChainLength,
  }

  const aad = serializeHeader(header)
  const aesKey = await importAesKey(messageKey)
  const { iv, ciphertext } = await encrypt(plaintext, aesKey, aad)

  const newState: RatchetState = {
    ...state,
    sendChainKey: nextChainKey,
    sendMessageNumber: state.sendMessageNumber + 1,
  }

  return { state: newState, header, iv, ciphertext }
}

export async function ratchetDecrypt(
  state: RatchetState,
  header: MessageHeader,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<{ state: RatchetState; plaintext: Uint8Array }> {
  // Try skipped message keys first
  const skippedResult = await trySkippedMessageKey(state, header, iv, ciphertext)
  if (skippedResult) {
    return skippedResult
  }

  let currentState = { ...state, skippedMessageKeys: new Map(state.skippedMessageKeys) }

  // Check if we need a DH ratchet step
  const headerPubKeyRaw = fromBase64Url(header.pubkey)
  let currentPubKeyB64: string | null = null
  if (currentState.remotePubKey) {
    const currentRaw = await exportPublicKey(currentState.remotePubKey)
    currentPubKeyB64 = toBase64Url(currentRaw)
  }

  if (header.pubkey !== currentPubKeyB64) {
    // Skip any missed messages on the current recv chain
    if (currentState.recvChainKey) {
      currentState = await skipMessageKeys(currentState, header.pn)
    }
    currentState = await dhRatchetStep(currentState, await importPublicKey(headerPubKeyRaw))
  }

  // Skip missed messages on the new recv chain
  currentState = await skipMessageKeys(currentState, header.n)

  // Derive message key
  if (!currentState.recvChainKey) {
    throw new Error('No receive chain key available')
  }
  const { nextChainKey, messageKey } = await kdfRatchetStep(currentState.recvChainKey)
  currentState.recvChainKey = nextChainKey
  currentState.recvMessageNumber = header.n + 1

  const aad = serializeHeader(header)
  const aesKey = await importAesKey(messageKey)
  const plaintext = await decrypt(ciphertext, iv, aesKey, aad)

  return { state: currentState, plaintext }
}

async function dhRatchetStep(
  state: RatchetState,
  newRemotePubKey: CryptoKey,
): Promise<RatchetState> {
  // Receive chain: DH with current key pair + new remote key
  const dhRecv = await deriveSharedSecret(state.dhKeyPair.privateKey, newRemotePubKey)
  const recvDerived = await hkdfDerive(dhRecv, state.rootKey, RATCHET_INFO, 64)
  const intermediateRootKey = recvDerived.slice(0, 32)
  const recvChainKey = recvDerived.slice(32, 64)

  // Send chain: new key pair + DH with new remote key
  const newKeyPair = await generateKeyPair()
  const dhSend = await deriveSharedSecret(newKeyPair.privateKey, newRemotePubKey)
  const sendDerived = await hkdfDerive(dhSend, intermediateRootKey, RATCHET_INFO, 64)
  const newRootKey = sendDerived.slice(0, 32)
  const sendChainKey = sendDerived.slice(32, 64)

  return {
    ...state,
    dhKeyPair: newKeyPair,
    remotePubKey: newRemotePubKey,
    rootKey: newRootKey,
    sendChainKey,
    sendMessageNumber: 0,
    recvChainKey,
    recvMessageNumber: 0,
    prevSendChainLength: state.sendMessageNumber,
  }
}

async function skipMessageKeys(
  state: RatchetState,
  until: number,
): Promise<RatchetState> {
  if (!state.recvChainKey) {
    return state
  }

  if (until - state.recvMessageNumber > MAX_SKIPPED_KEYS) {
    throw new Error('Too many skipped messages')
  }

  let chainKey = state.recvChainKey
  const skipped = new Map(state.skippedMessageKeys)

  let remotePubKeyB64 = ''
  if (state.remotePubKey) {
    const raw = await exportPublicKey(state.remotePubKey)
    remotePubKeyB64 = toBase64Url(raw)
  }

  for (let n = state.recvMessageNumber; n < until; n++) {
    const { nextChainKey, messageKey } = await kdfRatchetStep(chainKey)
    const key = `${remotePubKeyB64}:${n}`
    skipped.set(key, messageKey)
    chainKey = nextChainKey
  }

  return {
    ...state,
    recvChainKey: chainKey,
    recvMessageNumber: until,
    skippedMessageKeys: skipped,
  }
}

async function trySkippedMessageKey(
  state: RatchetState,
  header: MessageHeader,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<{ state: RatchetState; plaintext: Uint8Array } | null> {
  const key = `${header.pubkey}:${header.n}`
  const messageKey = state.skippedMessageKeys.get(key)
  if (!messageKey) {
    return null
  }

  const aad = serializeHeader(header)
  const aesKey = await importAesKey(messageKey)
  const plaintext = await decrypt(ciphertext, iv, aesKey, aad)

  const newSkipped = new Map(state.skippedMessageKeys)
  newSkipped.delete(key)

  return {
    state: { ...state, skippedMessageKeys: newSkipped },
    plaintext,
  }
}

export function destroyState(state: RatchetState): void {
  state.rootKey.fill(0)
  state.sendChainKey.fill(0)
  if (state.recvChainKey) {
    state.recvChainKey.fill(0)
  }
  for (const [, key] of state.skippedMessageKeys) {
    key.fill(0)
  }
  state.skippedMessageKeys.clear()
}

export { serializeHeader as _serializeHeader }
