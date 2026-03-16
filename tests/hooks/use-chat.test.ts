import { describe, it, expect } from 'vitest'
import type { ChatPhase, ChatMessage } from '@/hooks/use-chat'
import { _chunkBytes, _concatChunks, _insertSorted } from '@/hooks/use-chat'

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

  it('supports image chat message shape', () => {
    const msg: ChatMessage = {
      id: 'img1',
      kind: 'image',
      fileUrl: 'blob:image-test',
      fileName: 'photo.jpg',
      fileMimeType: 'image/jpeg',
      fileSize: 204800,
      sender: 'self',
      timestamp: Date.now(),
      reactions: [],
    }
    expect(msg.kind).toBe('image')
    expect(msg.fileUrl).toContain('blob:')
    expect(msg.fileName).toBe('photo.jpg')
    expect(msg.fileSize).toBe(204800)
  })

  it('supports file chat message shape', () => {
    const msg: ChatMessage = {
      id: 'f1',
      kind: 'file',
      fileUrl: 'blob:file-test',
      fileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1048576,
      sender: 'peer',
      timestamp: Date.now(),
      reactions: [],
    }
    expect(msg.kind).toBe('file')
    expect(msg.fileName).toBe('document.pdf')
    expect(msg.fileMimeType).toBe('application/pdf')
  })

  it('supports transferProgress on file messages', () => {
    const msg: ChatMessage = {
      id: 'f2',
      kind: 'image',
      fileUrl: '',
      fileName: 'photo.png',
      fileMimeType: 'image/png',
      fileSize: 500000,
      sender: 'peer',
      timestamp: Date.now(),
      reactions: [],
      transferProgress: 0.45,
    }
    expect(msg.transferProgress).toBe(0.45)
  })

  it('chunks and reassembles bytes', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const chunks = _chunkBytes(input, 3)
    expect(chunks).toHaveLength(3)
    const out = _concatChunks(chunks)
    expect(Array.from(out)).toEqual(Array.from(input))
  })

  it('chunks with file-sized chunk size', () => {
    // Simulate a small file with FILE_CHUNK_BYTES=16000
    const input = new Uint8Array(32001)
    for (let i = 0; i < input.length; i++) input[i] = i % 256
    const chunks = _chunkBytes(input, 16000)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.length).toBe(16000)
    expect(chunks[1]!.length).toBe(16000)
    expect(chunks[2]!.length).toBe(1)
    const out = _concatChunks(chunks)
    expect(out.length).toBe(32001)
    expect(Array.from(out)).toEqual(Array.from(input))
  })
})

function makeMsg(id: string, timestamp: number): ChatMessage {
  return { id, kind: 'text', text: id, sender: 'peer', timestamp, reactions: [] }
}

describe('_insertSorted', () => {
  it('appends to empty array', () => {
    const msg = makeMsg('a', 100)
    const result = _insertSorted([], msg)
    expect(result).toEqual([msg])
  })

  it('appends when newer than last (fast path)', () => {
    const existing = [makeMsg('a', 100), makeMsg('b', 200)]
    const msg = makeMsg('c', 300)
    const result = _insertSorted(existing, msg)
    expect(result.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('inserts in middle when out of order', () => {
    const existing = [makeMsg('a', 100), makeMsg('c', 300)]
    const msg = makeMsg('b', 200)
    const result = _insertSorted(existing, msg)
    expect(result.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('inserts at beginning when oldest', () => {
    const existing = [makeMsg('b', 200), makeMsg('c', 300)]
    const msg = makeMsg('a', 100)
    const result = _insertSorted(existing, msg)
    expect(result.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('tiebreaks by message ID on equal timestamps', () => {
    const existing = [makeMsg('a', 100), makeMsg('c', 100)]
    const msg = makeMsg('b', 100)
    const result = _insertSorted(existing, msg)
    expect(result.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate original array', () => {
    const existing = [makeMsg('a', 100), makeMsg('c', 300)]
    const original = [...existing]
    _insertSorted(existing, makeMsg('b', 200))
    expect(existing).toEqual(original)
  })

  it('handles multiple sequential out-of-order insertions', () => {
    let msgs: ChatMessage[] = []
    msgs = _insertSorted(msgs, makeMsg('c', 300))
    msgs = _insertSorted(msgs, makeMsg('a', 100))
    msgs = _insertSorted(msgs, makeMsg('d', 400))
    msgs = _insertSorted(msgs, makeMsg('b', 200))
    expect(msgs.map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
