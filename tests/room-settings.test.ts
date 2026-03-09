import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ROOM_SETTINGS,
  createSafeWordSettings,
  decodeRoomSettings,
  encodeRoomSettings,
  verifySafeWord,
} from '@/room-settings'

describe('room settings', () => {
  it('returns null encoded payload for defaults', () => {
    expect(encodeRoomSettings(DEFAULT_ROOM_SETTINGS)).toBeNull()
  })

  it('encodes and decodes username mode', () => {
    const encoded = encodeRoomSettings({
      usernameModeEnabled: true,
      safeWord: null,
    })
    const decoded = decodeRoomSettings(encoded)
    expect(decoded).toEqual({
      usernameModeEnabled: true,
      safeWord: null,
    })
  })

  it('creates safe word settings and verifies candidate', async () => {
    const safeWord = await createSafeWordSettings('orchid-crest')
    await expect(verifySafeWord('orchid-crest', safeWord)).resolves.toBe(true)
    await expect(verifySafeWord('wrong-word', safeWord)).resolves.toBe(false)
  })
})
