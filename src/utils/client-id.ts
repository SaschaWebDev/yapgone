import { STORAGE_KEYS } from '@/constants'

const cache = new Map<string, string>()

/**
 * Returns a stable per-room client identifier. Stored in localStorage so the
 * same identity survives mobile tab eviction (iOS Safari can wipe
 * sessionStorage when reloading a backgrounded tab). Cleared on explicit
 * leave via clearClientId so a fresh visit gets a new identity.
 */
export function getOrCreateClientId(roomId: string): string {
  const cached = cache.get(roomId)
  if (cached) return cached

  const key = `${STORAGE_KEYS.CLIENT_ID_PREFIX}${roomId}`
  try {
    const existing = localStorage.getItem(key)
    if (existing) {
      cache.set(roomId, existing)
      return existing
    }
    const id = crypto.randomUUID()
    localStorage.setItem(key, id)
    cache.set(roomId, id)
    return id
  } catch {
    const id = crypto.randomUUID()
    cache.set(roomId, id)
    return id
  }
}

/**
 * Removes the persisted client ID for a room. Call when the user explicitly
 * leaves so a fresh visit gets a new identity.
 */
export function clearClientId(roomId: string): void {
  cache.delete(roomId)
  try {
    localStorage.removeItem(`${STORAGE_KEYS.CLIENT_ID_PREFIX}${roomId}`)
  } catch {
    // ignore
  }
}
