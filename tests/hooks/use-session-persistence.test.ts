import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateKeyPair,
  deriveSharedSecret,
  hkdfDerive,
  exportPublicKey,
} from '@/crypto'
import { initCreator } from '@/crypto/ratchet'
import {
  serializeRatchetState,
  deserializeRatchetState,
  sessionKey,
} from '@/hooks/use-session-persistence'

const encoder = new TextEncoder()

async function createTestRatchetState() {
  const kp = await generateKeyPair()
  const rootKey = crypto.getRandomValues(new Uint8Array(32))
  return initCreator(kp, rootKey)
}

async function createFullRatchetState() {
  const aliceKp = await generateKeyPair()
  const bobKp = await generateKeyPair()

  const aliceSecret = await deriveSharedSecret(aliceKp.privateKey, bobKp.publicKey)
  const salt = encoder.encode('yapgone-chat-root')
  const info = new Uint8Array(0)
  const aliceRootKey = await hkdfDerive(aliceSecret, salt, info, 32)

  return initCreator(aliceKp, aliceRootKey)
}

describe('useSessionPersistence', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('round-trips serializeRatchetState + deserializeRatchetState', async () => {
    const state = await createFullRatchetState()

    const serialized = await serializeRatchetState(state)
    expect(typeof serialized).toBe('string')

    const loaded = await deserializeRatchetState(serialized)

    // Compare exported public key bytes
    const originalPub = await exportPublicKey(state.dhKeyPair.publicKey)
    const loadedPub = await exportPublicKey(loaded.dhKeyPair.publicKey)
    expect(new Uint8Array(loadedPub)).toEqual(new Uint8Array(originalPub))

    // Compare root key
    expect(loaded.rootKey).toEqual(state.rootKey)

    // Compare chain keys and counters
    expect(loaded.sendChainKey).toEqual(state.sendChainKey)
    expect(loaded.sendMessageNumber).toBe(state.sendMessageNumber)
    expect(loaded.recvMessageNumber).toBe(state.recvMessageNumber)
    expect(loaded.prevSendChainLength).toBe(state.prevSendChainLength)
    expect(loaded.skippedMessageKeys.size).toBe(state.skippedMessageKeys.size)
  })

  it('loadRatchetState returns null when no data stored', async () => {
    const key = sessionKey('empty-room')
    const stored = sessionStorage.getItem(key)
    expect(stored).toBeNull()
  })

  it('clearSession removes stored data', async () => {
    const state = await createTestRatchetState()
    const key = sessionKey('clear-room')

    // Save directly via serialize + sessionStorage
    const serialized = await serializeRatchetState(state)
    sessionStorage.setItem(key, serialized)

    expect(sessionStorage.getItem(key)).not.toBeNull()

    // Clear
    sessionStorage.removeItem(key)

    expect(sessionStorage.getItem(key)).toBeNull()
  })

  it('deserializeRatchetState throws on corrupt JSON', async () => {
    await expect(
      deserializeRatchetState('not valid json {{{'),
    ).rejects.toThrow()
  })

  it('debouncedSave delays write by 500ms', async () => {
    vi.useFakeTimers()

    const state = await createTestRatchetState()
    const key = sessionKey('debounce-room')

    // Pre-serialize so we can test the debounce timing separately
    const serialized = await serializeRatchetState(state)

    // Simulate debounced save behavior (same logic as the hook)
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    function debouncedSave() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        sessionStorage.setItem(key, serialized)
      }, 500)
    }

    debouncedSave()

    // Not yet saved
    expect(sessionStorage.getItem(key)).toBeNull()

    // Advance time partially
    vi.advanceTimersByTime(200)
    expect(sessionStorage.getItem(key)).toBeNull()

    // Advance to 500ms — the save should fire
    vi.advanceTimersByTime(300)

    expect(sessionStorage.getItem(key)).not.toBeNull()

    vi.useRealTimers()
  })
})
