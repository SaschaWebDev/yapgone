import { describe, it, expect, vi } from 'vitest'
import { buildInviteFragment, buildWsUrl, createRoom } from '@/api'

describe('api client', () => {
  it('buildInviteFragment formats roomId:pubKey', () => {
    const result = buildInviteFragment('room-123', 'pubkey-abc')
    expect(result).toBe('room-123:pubkey-abc')
  })

  it('buildWsUrl converts http to ws', () => {
    // buildWsUrl uses API_BASE_URL or window.location.origin
    // In test env, window.location.origin is available via happy-dom
    const url = buildWsUrl('test-room')
    expect(url).toMatch(/^wss?:\/\//)
    expect(url).toContain('/ws/test-room')
  })

  it('createRoom calls POST /api/rooms and returns roomId', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ roomId: 'abc-123' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const roomId = await createRoom()
    expect(roomId).toBe('abc-123')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rooms'),
      { method: 'POST' }
    )

    vi.unstubAllGlobals()
  })

  it('createRoom throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    await expect(createRoom()).rejects.toThrow('Failed to create room: 500')

    vi.unstubAllGlobals()
  })

  it('createRoom throws on invalid response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notRoomId: 'oops' }),
    }))

    await expect(createRoom()).rejects.toThrow('Invalid room response')

    vi.unstubAllGlobals()
  })
})
