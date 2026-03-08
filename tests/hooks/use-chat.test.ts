import { describe, it, expect } from 'vitest'
import type { ChatPhase, ChatMessage } from '@/hooks/use-chat'

describe('useChat types', () => {
  it('ChatPhase includes all expected phases', () => {
    const phases: ChatPhase[] = [
      'creating', 'waiting', 'connecting', 'key-exchange',
      'ready', 'peer-left', 'expired', 'error',
    ]
    expect(phases).toHaveLength(8)
  })

  it('ChatMessage has expected shape', () => {
    const msg: ChatMessage = {
      id: 'abc',
      text: 'hello',
      sender: 'self',
      timestamp: Date.now(),
    }
    expect(msg.sender).toBe('self')
    expect(typeof msg.id).toBe('string')
    expect(typeof msg.timestamp).toBe('number')
  })

  it('ChatMessage sender can be peer', () => {
    const msg: ChatMessage = {
      id: 'xyz',
      text: 'from peer',
      sender: 'peer',
      timestamp: Date.now(),
    }
    expect(msg.sender).toBe('peer')
  })
})
