import { STORAGE_KEYS } from '@/constants'

const cache = new Map<string, string>()

/**
 * Returns a stable per-tab client identifier for the given room. Stored in
 * sessionStorage so the same identity survives WebSocket reconnects after
 * mobile backgrounding (iOS Safari) without colliding with other tabs.
 * Falls back to an in-memory UUID if storage is unavailable.
 */
export function getOrCreateClientId(roomId: string): string {
  const cached = cache.get(roomId)
  if (cached) return cached

  const key = `${STORAGE_KEYS.CLIENT_ID_PREFIX}${roomId}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) {
      cache.set(roomId, existing)
      return existing
    }
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
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
    sessionStorage.removeItem(`${STORAGE_KEYS.CLIENT_ID_PREFIX}${roomId}`)
  } catch {
    // ignore
  }
}
