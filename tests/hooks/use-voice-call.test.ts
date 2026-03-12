import { describe, it, expect } from 'vitest'
import type { CallState } from '@/types'
import {
  _getIceHandlingStrategy,
  _shouldFailForConnectionState,
  _shouldStartDisconnectedGrace,
  _canEnterRingingOnIncoming,
  _canToggleE2ee,
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

describe('incoming call transition guard', () => {
  it('allows ringing from idle/ended/failed/requesting', () => {
    expect(_canEnterRingingOnIncoming('idle')).toBe(true)
    expect(_canEnterRingingOnIncoming('ended')).toBe(true)
    expect(_canEnterRingingOnIncoming('failed')).toBe(true)
    expect(_canEnterRingingOnIncoming('requesting')).toBe(true)
  })

  it('blocks ringing transition from connecting/active/ringing', () => {
    expect(_canEnterRingingOnIncoming('connecting')).toBe(false)
    expect(_canEnterRingingOnIncoming('active')).toBe(false)
    expect(_canEnterRingingOnIncoming('ringing')).toBe(false)
  })
})

describe('E2EE toggle guard', () => {
  it('allows toggle when active and not reconnecting', () => {
    expect(_canToggleE2ee('active', false)).toBe(true)
  })

  it('blocks toggle when reconnecting', () => {
    expect(_canToggleE2ee('active', true)).toBe(false)
  })

  it('blocks toggle when not in active call', () => {
    const nonActiveStates: CallState[] = ['idle', 'requesting', 'ringing', 'connecting', 'ended', 'failed']
    for (const state of nonActiveStates) {
      expect(_canToggleE2ee(state, false)).toBe(false)
    }
  })
})
