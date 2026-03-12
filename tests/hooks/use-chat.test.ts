import { describe, it, expect } from 'vitest'
import type { ChatPhase, ChatMessage } from '@/hooks/use-chat'
import { _chunkBytes, _concatChunks } from '@/hooks/use-chat'

describe('useChat types', () => {
  it('ChatPhase includes all expected phases', () => {
    const phases: ChatPhase[] = [
      'creating', 'waiting', 'connecting', 'key-exchange',
      'ready', 'peer-left', 'peer-disconnected', 'expired', 'room-closed', 'error',
    ]
    expect(phases).toHaveLength(10)
  })

  it('ChatMessage has expected shape', () => {
    const msg: ChatMessage = {
      id: 'abc',
      kind: 'text',
      text: 'hello',
      sender: 'self',
      timestamp: Date.now(),
      reactions: [],
    }
    expect(msg.sender).toBe('self')
    expect(typeof msg.id).toBe('string')
    expect(typeof msg.timestamp).toBe('number')
  })

  it('ChatMessage sender can be peer', () => {
    const msg: ChatMessage = {
      id: 'xyz',
      kind: 'text',
      text: 'from peer',
      sender: 'peer',
      timestamp: Date.now(),
      reactions: [],
    }
    expect(msg.sender).toBe('peer')
  })

  it('supports audio chat message shape', () => {
    const msg: ChatMessage = {
      id: 'a1',
      kind: 'audio',
      audioUrl: 'blob:test',
      durationMs: 1200,
      sender: 'peer',
      timestamp: Date.now(),
      reactions: [],
    }
    expect(msg.kind).toBe('audio')
    expect(msg.audioUrl).toContain('blob:')
  })

  it('chunks and reassembles bytes', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const chunks = _chunkBytes(input, 3)
    expect(chunks).toHaveLength(3)
    const out = _concatChunks(chunks)
    expect(Array.from(out)).toEqual(Array.from(input))
  })
})
