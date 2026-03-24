import { z } from 'zod'
import { API_BASE_URL } from '@/constants'
import type { RoomSettings } from '@/room-settings'
import { encodeRoomSettings } from '@/room-settings'

const CreateRoomResponseSchema = z.object({ roomId: z.string() })
const ShardResponseSchema = z.object({ shard: z.string() })

export async function createRoom(maxClients?: number): Promise<string> {
  const body = maxClients ? JSON.stringify({ maxClients }) : undefined
  const headers: Record<string, string> = {}
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE_URL}/api/rooms`, {
    method: 'POST',
    headers,
    body,
  })
  if (!res.ok) {
    throw new Error(`Failed to create room: ${res.status}`)
  }
  const data: unknown = await res.json()
  const parsed = CreateRoomResponseSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('Invalid room response')
  }
  return parsed.data.roomId
}

export async function updateRoomConfig(roomId: string, maxClients: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/rooms/${roomId}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxClients }),
  })
  if (!res.ok) {
    throw new Error(`Failed to update room config: ${res.status}`)
  }
}

export async function storeShard(roomId: string, shard: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/rooms/${roomId}/shard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shard }),
  })
  if (!res.ok) {
    throw new Error(`Failed to store shard: ${res.status}`)
  }
}

export async function fetchShard(roomId: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/rooms/${roomId}/shard`)
  if (!res.ok) {
    throw new Error(`Shard not found or already consumed: ${res.status}`)
  }
  const data: unknown = await res.json()
  const parsed = ShardResponseSchema.safeParse(data)
  if (!parsed.success) {
    throw new Error('Invalid shard response')
  }
  return parsed.data.shard
}

const NotefadeResponseSchema = z.object({ url: z.string().url() })
const NotefadeReadResponseSchema = z.object({ text: z.string(), shardId: z.string() })
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

export async function readNotefadeNote(url: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/notefade/read-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('Note not found or already read')
    }
    const body: unknown = await res.json().catch(() => null)
    const errorParsed = NotefadeErrorSchema.safeParse(body)
    const message = errorParsed.success
      ? errorParsed.data.error
      : `Failed to read note: ${res.status}`
    throw new Error(message)
  }
  const data: unknown = await res.json()
  const parsed = NotefadeReadResponseSchema.parse(data)
  return parsed.text
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

/**
 * Build an invite fragment using only the URL share (server shard stored separately).
 * Format: `roomId:~urlShareB64[:encodedSettings]`
 * The `~` prefix distinguishes split invites from direct pubkey invites.
 */
export function buildSplitInviteFragment(
  roomId: string,
  urlShareB64: string,
  roomSettings?: RoomSettings | null,
): string {
  const encoded = roomSettings ? encodeRoomSettings(roomSettings) : null
  if (!encoded) {
    return `${roomId}:~${urlShareB64}`
  }
  return `${roomId}:~${urlShareB64}:${encoded}`
}

/**
 * Check if a fragment uses XOR-split invite format.
 */
export function isSplitInvite(pubKeyOrShare: string): boolean {
  return pubKeyOrShare.startsWith('~')
}

/**
 * Extract the URL share from a split invite (removes the `~` prefix).
 */
export function extractUrlShare(pubKeyOrShare: string): string {
  return pubKeyOrShare.slice(1)
}
