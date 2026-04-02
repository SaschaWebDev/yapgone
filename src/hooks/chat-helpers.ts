import { toBase64Url } from '@/crypto'

export interface MessageReaction {
  emoji: string
  fromSelf: boolean
  senderId?: string
}

export interface PollOption {
  text: string
  emoji: string
  votes: number
}

export interface GalleryImage {
  fileId: string
  fileUrl?: string
  fileName: string
  mimeType: string
  fileSize: number
  transferProgress?: number
}

export interface ChatMessage {
  id: string
  kind: 'text' | 'audio' | 'image' | 'file' | 'poll' | 'gallery' | 'notefade' | 'notefade-chat'
  text?: string
  audioUrl?: string
  durationMs?: number
  fileUrl?: string
  fileName?: string
  fileMimeType?: string
  fileSize?: number
  sender: 'self' | 'peer' | 'system'
  senderId?: string
  displayName?: string
  timestamp: number
  reactions: MessageReaction[]
  replyTo?: string
  replyPreview?: string
  waveform?: readonly number[]
  timed?: boolean
  timedConsumed?: boolean
  transferProgress?: number
  pollId?: string
  pollQuestion?: string
  pollEmoji?: string
  pollOptions?: PollOption[]
  pollAllowMultiple?: boolean
  pollMyVotes?: number[]
  gallery?: GalleryImage[]
  notefadeUrl?: string
  notefadeRevealedText?: string
  notefadeRevealed?: boolean
  notefadeDestroyed?: boolean
}

export function generateMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return toBase64Url(bytes)
}

export function buildTextMessage(
  sender: 'self' | 'peer' | 'system',
  text: string,
  displayName?: string,
  id?: string,
  timestamp?: number,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'text',
    text,
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
  }
}

export function buildAudioMessage(
  sender: 'self' | 'peer',
  objectUrl: string,
  durationMs: number,
  displayName?: string,
  id?: string,
  timed?: boolean,
  timestamp?: number,
  waveform?: readonly number[],
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'audio',
    audioUrl: objectUrl,
    durationMs,
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
    timed: timed || undefined,
    waveform,
  }
}

export function buildFileMessage(
  sender: 'self' | 'peer',
  kind: 'image' | 'file',
  objectUrl: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
  displayName?: string,
  id?: string,
  timed?: boolean,
  timestamp?: number,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind,
    fileUrl: objectUrl,
    fileName,
    fileMimeType: mimeType,
    fileSize,
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
    timed: timed || undefined,
  }
}

export function buildNotefadeMessage(
  sender: 'self' | 'peer',
  url: string,
  displayName?: string,
  id?: string,
  timestamp?: number,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'notefade',
    notefadeUrl: url,
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
  }
}

export function buildNotefadeChatMessage(
  sender: 'self' | 'peer',
  url: string,
  displayName?: string,
  id?: string,
  timestamp?: number,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'notefade-chat',
    notefadeUrl: url,
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
  }
}

export function buildPollMessage(
  sender: 'self' | 'peer',
  pollId: string,
  question: string,
  questionEmoji: string,
  options: Array<{ text: string; emoji: string }>,
  allowMultiple: boolean,
  displayName?: string,
  timestamp?: number,
): ChatMessage {
  return {
    id: pollId,
    kind: 'poll',
    sender,
    displayName,
    timestamp: timestamp ?? Date.now(),
    reactions: [],
    pollId,
    pollQuestion: question,
    pollEmoji: questionEmoji,
    pollOptions: options.map(o => ({ text: o.text, emoji: o.emoji, votes: 0 })),
    pollAllowMultiple: allowMultiple,
    pollMyVotes: [],
  }
}

export function applyReaction(
  messages: ChatMessage[],
  msgId: string,
  emoji: string,
  action: 'add' | 'remove',
  fromSelf: boolean,
  senderId?: string,
): ChatMessage[] {
  return messages.map(msg => {
    if (msg.id !== msgId) return msg
    let reactions = [...msg.reactions]
    if (action === 'add') {
      if (senderId) {
        reactions = reactions.filter(r => r.senderId !== senderId)
      } else {
        reactions = reactions.filter(r => r.fromSelf !== fromSelf)
      }
      reactions = [...reactions, { emoji, fromSelf, senderId }]
    } else {
      if (senderId) {
        reactions = reactions.filter(r => !(r.emoji === emoji && r.senderId === senderId))
      } else {
        reactions = reactions.filter(r => !(r.emoji === emoji && r.fromSelf === fromSelf))
      }
    }
    return { ...msg, reactions }
  })
}

export function findReplyPreview(messages: ChatMessage[], replyTo: string): string | undefined {
  const target = messages.find(m => m.id === replyTo)
  if (!target) return undefined
  if (target.kind === 'audio') return '(voice note)'
  if (target.kind === 'image') return '(image)'
  if (target.kind === 'file') return `(file: ${target.fileName ?? 'unknown'})`
  if (target.kind === 'poll') return '(poll)'
  if (target.kind === 'gallery') return '(photo gallery)'
  if (target.kind === 'notefade') return '(self-destructing note)'
  if (target.kind === 'notefade-chat') return '(secret note)'
  if (target.timed) return '(timed message)'
  const text = target.text ?? ''
  return text.length > 80 ? text.slice(0, 80) + '...' : text
}

export function applyPollVote(
  messages: ChatMessage[],
  pollId: string,
  optionIndices: number[],
  fromSelf: boolean,
  previousVotes: number[],
): ChatMessage[] {
  return messages.map(msg => {
    if (msg.pollId !== pollId || !msg.pollOptions) return msg
    const options = msg.pollOptions.map((opt, i) => {
      let votes = opt.votes
      if (previousVotes.includes(i)) votes--
      if (optionIndices.includes(i)) votes++
      return { ...opt, votes: Math.max(0, votes) }
    })
    const pollMyVotes = fromSelf ? [...optionIndices] : msg.pollMyVotes
    return { ...msg, pollOptions: options, pollMyVotes }
  })
}

export function insertSorted(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const len = messages.length
  const last = len > 0 ? messages[len - 1] : undefined
  // Fast path: newer than last message — append (common case)
  if (!last || msg.timestamp > last.timestamp ||
    (msg.timestamp === last.timestamp && msg.id >= last.id)) {
    return [...messages, msg]
  }
  // Slow path: binary search for insertion point
  let lo = 0
  let hi = len
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const m = messages[mid]
    if (!m) { lo = mid + 1; continue }
    const cmp = m.timestamp - msg.timestamp
    if (cmp < 0 || (cmp === 0 && m.id < msg.id)) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const result = messages.slice()
  result.splice(lo, 0, msg)
  return result
}

export function chunkBytes(input: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize))
  }
  return chunks
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}