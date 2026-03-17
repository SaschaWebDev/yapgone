import { describe, it, expect } from 'vitest'
import type { ChatPhase, ChatMessage } from '@/hooks/use-chat'
import { _chunkBytes, _concatChunks, _insertSorted, _buildPollMessage, _applyPollVote } from '@/hooks/use-chat'

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

describe('_buildPollMessage', () => {
  it('returns correct shape with votes at 0', () => {
    const msg = _buildPollMessage(
      'self', 'poll1', 'Favorite color?', '\u{1F4CA}',
      [{ text: 'Red', emoji: '🔴' }, { text: 'Blue', emoji: '🔵' }],
      false, 'alice', 1000,
    )
    expect(msg.kind).toBe('poll')
    expect(msg.pollId).toBe('poll1')
    expect(msg.pollQuestion).toBe('Favorite color?')
    expect(msg.pollEmoji).toBe('\u{1F4CA}')
    expect(msg.pollAllowMultiple).toBe(false)
    expect(msg.pollMyVotes).toEqual([])
    expect(msg.pollOptions).toHaveLength(2)
    expect(msg.pollOptions![0]!.votes).toBe(0)
    expect(msg.pollOptions![1]!.votes).toBe(0)
    expect(msg.sender).toBe('self')
    expect(msg.displayName).toBe('alice')
    expect(msg.timestamp).toBe(1000)
  })
})

describe('_applyPollVote', () => {
  function makePollMessages(): ChatMessage[] {
    return [_buildPollMessage(
      'self', 'poll1', 'Q?', '\u{1F4CA}',
      [{ text: 'A', emoji: '1️⃣' }, { text: 'B', emoji: '2️⃣' }, { text: 'C', emoji: '3️⃣' }],
      false, undefined, 1000,
    )]
  }

  it('single-select vote increments correct option', () => {
    const msgs = makePollMessages()
    const result = _applyPollVote(msgs, 'poll1', [1], true, [])
    expect(result[0]!.pollOptions![0]!.votes).toBe(0)
    expect(result[0]!.pollOptions![1]!.votes).toBe(1)
    expect(result[0]!.pollOptions![2]!.votes).toBe(0)
  })

  it('multi-select vote increments multiple options', () => {
    const msgs = makePollMessages()
    const result = _applyPollVote(msgs, 'poll1', [0, 2], true, [])
    expect(result[0]!.pollOptions![0]!.votes).toBe(1)
    expect(result[0]!.pollOptions![1]!.votes).toBe(0)
    expect(result[0]!.pollOptions![2]!.votes).toBe(1)
  })

  it('replacing previous votes decrements old and increments new', () => {
    const msgs = makePollMessages()
    // First vote for option 0
    const after1 = _applyPollVote(msgs, 'poll1', [0], true, [])
    expect(after1[0]!.pollOptions![0]!.votes).toBe(1)
    // Change vote to option 2
    const after2 = _applyPollVote(after1, 'poll1', [2], true, [0])
    expect(after2[0]!.pollOptions![0]!.votes).toBe(0)
    expect(after2[0]!.pollOptions![2]!.votes).toBe(1)
  })

  it('fromSelf updates pollMyVotes, fromPeer does not', () => {
    const msgs = makePollMessages()
    const selfResult = _applyPollVote(msgs, 'poll1', [1], true, [])
    expect(selfResult[0]!.pollMyVotes).toEqual([1])
    const peerResult = _applyPollVote(msgs, 'poll1', [2], false, [])
    expect(peerResult[0]!.pollMyVotes).toEqual([])
  })
})
