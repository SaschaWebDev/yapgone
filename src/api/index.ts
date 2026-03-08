import { API_BASE_URL } from '@/constants'

export async function createRoom(): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/rooms`, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`Failed to create room: ${res.status}`)
  }
  const data: unknown = await res.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('roomId' in data) ||
    typeof (data as Record<string, unknown>).roomId !== 'string'
  ) {
    throw new Error('Invalid room response')
  }
  return (data as Record<string, unknown>).roomId as string
}

export function buildWsUrl(roomId: string): string {
  const base = API_BASE_URL || window.location.origin
  const protocol = base.startsWith('https') ? 'wss' : 'ws'
  const host = base.replace(/^https?:\/\//, '')
  return `${protocol}://${host}/ws/${roomId}`
}

export function buildInviteFragment(roomId: string, pubKeyB64: string): string {
  return `${roomId}:${pubKeyB64}`
}
