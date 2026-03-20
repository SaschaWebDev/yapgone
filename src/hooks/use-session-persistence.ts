import { useEffect, useCallback, useRef } from 'react'
import { exportPublicKey, importPublicKey, toBase64Url, fromBase64Url } from '@/crypto'
import type { RatchetState } from '@/types'

const SESSION_KEY_PREFIX = 'yapgone-session-'

/**
 * Serializable snapshot of a RatchetState.
 * CryptoKeys are exported as raw bytes (base64url encoded).
 * Security note: sessionStorage is accessible to same-origin JS.
 * This is a documented tradeoff for page-refresh survival.
 */
interface SerializedRatchetState {
  dhPubKey: string
  dhPrivKey: string
  remotePubKey: string | null
  rootKey: string
  sendChainKey: string
  sendMessageNumber: number
  recvChainKey: string | null
  recvMessageNumber: number
  prevSendChainLength: number
  skippedMessageKeys: Array<[string, string]>
}

/** @internal exported for testing */
export async function serializeRatchetState(state: RatchetState): Promise<string> {
  const pubKeyRaw = await crypto.subtle.exportKey('raw', state.dhKeyPair.publicKey)
  const privKeyJwk = await crypto.subtle.exportKey('jwk', state.dhKeyPair.privateKey)

  let remotePubKeyB64: string | null = null
  if (state.remotePubKey) {
    const remotePubRaw = await exportPublicKey(state.remotePubKey)
    remotePubKeyB64 = toBase64Url(remotePubRaw)
  }

  const skipped: Array<[string, string]> = []
  for (const [key, value] of state.skippedMessageKeys) {
    skipped.push([key, toBase64Url(value)])
  }

  const serialized: SerializedRatchetState = {
    dhPubKey: toBase64Url(new Uint8Array(pubKeyRaw)),
    dhPrivKey: JSON.stringify(privKeyJwk),
    remotePubKey: remotePubKeyB64,
    rootKey: toBase64Url(state.rootKey),
    sendChainKey: toBase64Url(state.sendChainKey),
    sendMessageNumber: state.sendMessageNumber,
    recvChainKey: state.recvChainKey ? toBase64Url(state.recvChainKey) : null,
    recvMessageNumber: state.recvMessageNumber,
    prevSendChainLength: state.prevSendChainLength,
    skippedMessageKeys: skipped,
  }

  return JSON.stringify(serialized)
}

/** @internal exported for testing */
export async function deserializeRatchetState(json: string): Promise<RatchetState> {
  const data: SerializedRatchetState = JSON.parse(json) as SerializedRatchetState

  const privKeyJwk = JSON.parse(data.dhPrivKey) as JsonWebKey
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )

  const pubKeyRaw = fromBase64Url(data.dhPubKey)
  const publicKey = await importPublicKey(pubKeyRaw)
  // Re-create as an ECDH key for the pair
  const dhKeyPair: CryptoKeyPair = { privateKey, publicKey }

  let remotePubKey: CryptoKey | null = null
  if (data.remotePubKey) {
    const remoteRaw = fromBase64Url(data.remotePubKey)
    remotePubKey = await importPublicKey(remoteRaw)
  }

  const skippedMessageKeys = new Map<string, Uint8Array>()
  for (const [key, value] of data.skippedMessageKeys) {
    skippedMessageKeys.set(key, fromBase64Url(value))
  }

  return {
    dhKeyPair,
    remotePubKey,
    rootKey: fromBase64Url(data.rootKey),
    sendChainKey: fromBase64Url(data.sendChainKey),
    sendMessageNumber: data.sendMessageNumber,
    recvChainKey: data.recvChainKey ? fromBase64Url(data.recvChainKey) : null,
    recvMessageNumber: data.recvMessageNumber,
    prevSendChainLength: data.prevSendChainLength,
    skippedMessageKeys,
  }
}

/** @internal exported for testing */
export function sessionKey(roomId: string): string {
  return `${SESSION_KEY_PREFIX}${roomId}`
}

export function useSessionPersistence(roomId: string) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const saveRatchetState = useCallback(async (state: RatchetState) => {
    try {
      const serialized = await serializeRatchetState(state)
      sessionStorage.setItem(sessionKey(roomId), serialized)
    } catch {
      // Serialization failed — silently skip
    }
  }, [roomId])

  const loadRatchetState = useCallback(async (): Promise<RatchetState | null> => {
    try {
      const stored = sessionStorage.getItem(sessionKey(roomId))
      if (!stored) return null
      return await deserializeRatchetState(stored)
    } catch {
      // Deserialization failed — clear corrupt data
      sessionStorage.removeItem(sessionKey(roomId))
      return null
    }
  }, [roomId])

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(sessionKey(roomId))
  }, [roomId])

  /**
   * Debounced save — avoids saving on every message.
   * Saves at most every 500ms.
   */
  const debouncedSave = useCallback((state: RatchetState) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = setTimeout(() => {
      void saveRatchetState(state)
    }, 500)
  }, [saveRatchetState])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  return {
    saveRatchetState,
    loadRatchetState,
    clearSession,
    debouncedSave,
  }
}
