import { buf } from './buffer'
import { kdfRatchetStep } from './kdf'
import { encrypt, decrypt, importAesKey } from './encrypt'
import { concatBytes } from './keys'
import { MAX_SKIPPED_KEYS } from '@/constants'

export interface SenderKeyState {
  signingKeyPair: CryptoKeyPair
  chainKey: Uint8Array
  messageNumber: number
}

export interface ReceivedSenderKey {
  verifyingKey: CryptoKey
  chainKey: Uint8Array
  nextMessageNumber: number
  skippedKeys: Map<number, Uint8Array>
}

export interface ExportedSenderKey {
  verifyingKeyRaw: Uint8Array
  chainKey: Uint8Array
}

function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = (n >>> 24) & 0xff
  b[1] = (n >>> 16) & 0xff
  b[2] = (n >>> 8) & 0xff
  b[3] = n & 0xff
  return b
}

export async function generateSenderKey(): Promise<SenderKeyState> {
  const signingKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const chainKey = crypto.getRandomValues(new Uint8Array(32))
  return { signingKeyPair, chainKey, messageNumber: 0 }
}

export async function exportSenderKeyForDistribution(
  state: SenderKeyState,
): Promise<ExportedSenderKey> {
  const rawKey = await crypto.subtle.exportKey('raw', state.signingKeyPair.publicKey)
  return {
    verifyingKeyRaw: new Uint8Array(rawKey),
    chainKey: new Uint8Array(state.chainKey),
  }
}

export async function importReceivedSenderKey(
  verifyingKeyRaw: Uint8Array,
  chainKey: Uint8Array,
): Promise<ReceivedSenderKey> {
  const verifyingKey = await crypto.subtle.importKey(
    'raw',
    buf(verifyingKeyRaw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  )
  return {
    verifyingKey,
    chainKey: new Uint8Array(chainKey),
    nextMessageNumber: 0,
    skippedKeys: new Map(),
  }
}

export async function senderKeyEncrypt(
  state: SenderKeyState,
  plaintext: Uint8Array,
): Promise<{
  state: SenderKeyState
  messageNumber: number
  iv: Uint8Array
  ciphertext: Uint8Array
  signature: Uint8Array
}> {
  const { nextChainKey, messageKey } = await kdfRatchetStep(state.chainKey)
  const aesKey = await importAesKey(messageKey)
  const { iv, ciphertext } = await encrypt(plaintext, aesKey)

  const numberBytes = uint32BE(state.messageNumber)
  const signedData = concatBytes(numberBytes, iv, ciphertext)
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    state.signingKeyPair.privateKey,
    buf(signedData),
  )

  const newState: SenderKeyState = {
    signingKeyPair: state.signingKeyPair,
    chainKey: nextChainKey,
    messageNumber: state.messageNumber + 1,
  }

  return {
    state: newState,
    messageNumber: state.messageNumber,
    iv,
    ciphertext,
    signature: new Uint8Array(sig),
  }
}

export async function senderKeyDecrypt(
  received: ReceivedSenderKey,
  messageNumber: number,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  signature: Uint8Array,
): Promise<{ received: ReceivedSenderKey; plaintext: Uint8Array }> {
  // Verify signature first
  const numberBytes = uint32BE(messageNumber)
  const signedData = concatBytes(numberBytes, iv, ciphertext)
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    received.verifyingKey,
    buf(signature),
    buf(signedData),
  )
  if (!valid) {
    throw new Error('Invalid sender key signature')
  }

  // Try skipped keys for out-of-order messages that arrived earlier
  if (messageNumber < received.nextMessageNumber) {
    const skippedKey = received.skippedKeys.get(messageNumber)
    if (!skippedKey) {
      throw new Error('Message key not found for past message')
    }
    const aesKey = await importAesKey(skippedKey)
    const plaintext = await decrypt(ciphertext, iv, aesKey)

    const newSkipped = new Map(received.skippedKeys)
    newSkipped.delete(messageNumber)

    return {
      received: { ...received, skippedKeys: newSkipped },
      plaintext,
    }
  }

  // Skip ahead if messageNumber > nextMessageNumber
  const skip = messageNumber - received.nextMessageNumber
  if (skip > MAX_SKIPPED_KEYS) {
    throw new Error('Too many skipped messages')
  }

  let chainKey = received.chainKey
  const newSkipped = new Map(received.skippedKeys)

  for (let n = received.nextMessageNumber; n < messageNumber; n++) {
    const stepped = await kdfRatchetStep(chainKey)
    newSkipped.set(n, stepped.messageKey)
    chainKey = stepped.nextChainKey
  }

  // Derive message key for the current message
  const { nextChainKey, messageKey } = await kdfRatchetStep(chainKey)
  const aesKey = await importAesKey(messageKey)
  const plaintext = await decrypt(ciphertext, iv, aesKey)

  return {
    received: {
      ...received,
      chainKey: nextChainKey,
      nextMessageNumber: messageNumber + 1,
      skippedKeys: newSkipped,
    },
    plaintext,
  }
}

export function destroySenderKeyState(state: SenderKeyState): void {
  state.chainKey.fill(0)
}

export function destroyReceivedSenderKey(received: ReceivedSenderKey): void {
  received.chainKey.fill(0)
  for (const [, key] of received.skippedKeys) {
    key.fill(0)
  }
  received.skippedKeys.clear()
}
