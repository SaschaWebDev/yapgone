import { describe, it, expect } from 'vitest'
import type { CallState } from '@/types'
import {
  _getIceHandlingStrategy,
  _shouldFailForConnectionState,
  _shouldStartDisconnectedGrace,
} from '@/hooks/use-voice-call'

describe('voice call ICE strategy', () => {
  it('buffers ICE before peer connection exists', () => {
    expect(_getIceHandlingStrategy(false, false)).toBe('buffer-pre-pc')
  })

  it('buffers ICE before remote description is set', () => {
    expect(_getIceHandlingStrategy(true, false)).toBe('buffer-pre-remote')
  })

  it('applies ICE immediately after remote description is present', () => {
    expect(_getIceHandlingStrategy(true, true)).toBe('apply-now')
  })
})

describe('voice call ICE failure transitions', () => {
  const activeStates: CallState[] = ['connecting', 'active']
  const inactiveStates: CallState[] = ['idle', 'requesting', 'ringing', 'ended', 'failed']

  it('fails immediately on failed ICE for active/connecting calls', () => {
    for (const state of activeStates) {
      expect(_shouldFailForConnectionState(state, 'failed')).toBe(true)
    }
  })

  it('does not fail on failed ICE for non-call states', () => {
    for (const state of inactiveStates) {
      expect(_shouldFailForConnectionState(state, 'failed')).toBe(false)
    }
  })

  it('starts disconnected grace only for active/connecting without existing timer', () => {
    expect(_shouldStartDisconnectedGrace('connecting', 'disconnected', false)).toBe(true)
    expect(_shouldStartDisconnectedGrace('active', 'disconnected', false)).toBe(true)
    expect(_shouldStartDisconnectedGrace('active', 'disconnected', true)).toBe(false)
    expect(_shouldStartDisconnectedGrace('idle', 'disconnected', false)).toBe(false)
  })
})
