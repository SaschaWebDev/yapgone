import { describe, it, expect } from 'vitest'
import { ClientMessageSchema, ServerMessageSchema } from '@/ws/protocol'

describe('ws message validation', () => {
  it('validates pubkey client message', () => {
    const msg = { type: 'pubkey', key: 'abc123' }
    const result = ClientMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('validates chat message with header', () => {
    const msg = {
      type: 'message',
      header: { pubkey: 'key123', n: 0, pn: 0 },
      payload: 'encrypted-data',
    }
    const result = ClientMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('validates typing message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'typing', active: true })
    expect(result.success).toBe(true)
  })

  it('validates leave message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'leave' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid client message type', () => {
    const result = ClientMessageSchema.safeParse({ type: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('rejects message with negative n', () => {
    const msg = {
      type: 'message',
      header: { pubkey: 'key', n: -1, pn: 0 },
      payload: 'data',
    }
    const result = ClientMessageSchema.safeParse(msg)
    expect(result.success).toBe(false)
  })

  it('validates server peer-joined', () => {
    const result = ServerMessageSchema.safeParse({ type: 'peer-joined', clientId: 'abc', clientCount: 2 })
    expect(result.success).toBe(true)
  })

  it('validates server error', () => {
    const msg = { type: 'error', code: 'RATE_LIMIT', message: 'Too fast' }
    const result = ServerMessageSchema.safeParse(msg)
    expect(result.success).toBe(true)
  })

  it('rejects invalid server message', () => {
    const result = ServerMessageSchema.safeParse({ type: 'unknown' })
    expect(result.success).toBe(false)
  })

  it('message serialization produces valid JSON', () => {
    const msg = {
      type: 'message' as const,
      header: { pubkey: 'key', n: 0, pn: 0 },
      payload: 'data',
    }
    const json = JSON.stringify(msg)
    const parsed = ClientMessageSchema.safeParse(JSON.parse(json))
    expect(parsed.success).toBe(true)
  })
})
