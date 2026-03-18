import { z } from 'zod'
import { API_BASE_URL } from '@/constants'
import type { RoomSettings } from '@/room-settings'
import { encodeRoomSettings } from '@/room-settings'

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

const NotefadeResponseSchema = z.object({ url: z.string().url() })
const NotefadeErrorSchema = z.object({ error: z.string() })

export async function createNotefadeNote(text: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/notefade/create-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    const errorParsed = NotefadeErrorSchema.safeParse(body)
    const message = errorParsed.success
      ? errorParsed.data.error
      : `Failed to create note: ${res.status}`
    throw new Error(message)
  }
  const data: unknown = await res.json()
  const parsed = NotefadeResponseSchema.parse(data)
  return parsed.url
}

export function buildWsUrl(roomId: string): string {
  const base = API_BASE_URL || window.location.origin
  const protocol = base.startsWith('https') ? 'wss' : 'ws'
  const host = base.replace(/^https?:\/\//, '')
  return `${protocol}://${host}/ws/${roomId}`
}

export function buildInviteFragment(
  roomId: string,
  pubKeyB64: string,
  roomSettings?: RoomSettings | null,
): string {
  const encoded = roomSettings ? encodeRoomSettings(roomSettings) : null
  if (!encoded) {
    return `${roomId}:${pubKeyB64}`
  }
  return `${roomId}:${pubKeyB64}:${encoded}`
}
