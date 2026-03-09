import { describe, it, expect } from 'vitest'
import { parseFragment } from '@/hooks'
import { encodeRoomSettings } from '@/room-settings'

describe('parseFragment', () => {
  it('parses legacy fragment without settings', () => {
    const parsed = parseFragment('#room-1:pub-key')
    expect(parsed).toEqual({
      mode: 'chat',
      roomId: 'room-1',
      creatorPubKey: 'pub-key',
      roomSettings: null,
    })
  })

  it('parses fragment with encoded room settings', () => {
    const encoded = encodeRoomSettings({
      usernameModeEnabled: true,
      safeWord: null,
    })
    const parsed = parseFragment(`#room-1:pub-key:${encoded}`)
    expect(parsed).toEqual({
      mode: 'chat',
      roomId: 'room-1',
      creatorPubKey: 'pub-key',
      roomSettings: {
        usernameModeEnabled: true,
        safeWord: null,
      },
    })
  })
})
