import { useState, useRef, useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { z } from 'zod'
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecret,
  hkdfDerive,
  toBase64Url,
  fromBase64Url,
  concatBytes,
  initCreator,
  initJoiner,
  ratchetEncrypt,
  ratchetDecrypt,
  destroyState,
  deriveMediaKeyRaw,
} from '@/crypto'
import { createReconnectingWebSocket } from '@/ws/reconnecting-client'
import type { ReconnectingChatWebSocket } from '@/ws/reconnecting-client'
import type { ClientMessage, ServerMessage } from '@/ws'
import type { RatchetState, VoiceSignal } from '@/types'
import { buildWsUrl, buildInviteFragment } from '@/api'
import { computeWaveform } from '@/utils'
import type { RoomSettings } from '@/room-settings'
import { DEFAULT_ROOM_SETTINGS, normalizeRoomSettings } from '@/room-settings'
import {
  MAX_MESSAGE_LENGTH,
  VOICE_NOTE_ASSEMBLY_TIMEOUT_MS,
  VOICE_NOTE_CHUNK_BYTES,
  VOICE_NOTE_MAX_BYTES,
  FILE_MAX_IMAGE_BYTES,
  FILE_MAX_GENERAL_BYTES,
  FILE_CHUNK_BYTES,
  FILE_ASSEMBLY_TIMEOUT_MS,
  FILE_MAX_CONCURRENT_TRANSFERS,
  FILE_SEND_DELAY_MS,
  IMAGE_MIME_TYPES,
  GALLERY_MAX_IMAGES,
} from '@/constants'

export type ChatPhase =
  | 'creating'
  | 'waiting'
  | 'connecting'
  | 'key-exchange'
  | 'ready'
  | 'peer-left'
  | 'peer-disconnected'
  | 'expired'
  | 'room-closed'
  | 'error'

export interface MessageReaction {
  emoji: string
  fromSelf: boolean
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
  kind: 'text' | 'audio' | 'image' | 'file' | 'poll' | 'gallery' | 'notefade'
  text?: string
  audioUrl?: string
  durationMs?: number
  fileUrl?: string
  fileName?: string
  fileMimeType?: string
  fileSize?: number
  sender: 'self' | 'peer' | 'system'
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
}

const SALT = new TextEncoder().encode('yapgone-chat-root')
const INFO = new Uint8Array(0)

const DecryptedPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    content: z.string(),
    msgId: z.string().min(1).max(32).optional(),
    replyTo: z.string().min(1).max(32).optional(),
    timed: z.boolean().optional(),
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('voice-note-meta'),
    noteId: z.string().min(1),
    mimeType: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    totalChunks: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
    timed: z.boolean().optional(),
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('voice-note-chunk'),
    noteId: z.string().min(1),
    index: z.number().int().nonnegative(),
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal('voice-note-complete'),
    noteId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('file-meta'),
    fileId: z.string().min(1),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1),
    totalChunks: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
    timed: z.boolean().optional(),
    ts: z.number().optional(),
    galleryId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('file-chunk'),
    fileId: z.string().min(1),
    index: z.number().int().nonnegative(),
    data: z.string().min(1),
    galleryId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('file-complete'),
    fileId: z.string().min(1),
    galleryId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('gallery-meta'),
    galleryId: z.string().min(1),
    caption: z.string().max(65536).optional(),
    timed: z.boolean().optional(),
    ts: z.number().optional(),
    images: z.array(z.object({
      fileId: z.string().min(1),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1),
      totalChunks: z.number().int().positive(),
      totalBytes: z.number().int().positive(),
    })).min(1).max(5),
  }),
  z.object({
    kind: z.literal('gallery-complete'),
    galleryId: z.string().min(1),
  }),
  z.object({ kind: z.literal('voice-request') }),
  z.object({ kind: z.literal('voice-accept') }),
  z.object({ kind: z.literal('voice-decline') }),
  z.object({ kind: z.literal('sdp-offer'), sdp: z.string() }),
  z.object({ kind: z.literal('sdp-answer'), sdp: z.string() }),
  z.object({ kind: z.literal('ice-candidate'), candidate: z.string() }),
  z.object({ kind: z.literal('voice-end') }),
  z.object({ kind: z.literal('screen-share-start') }),
  z.object({ kind: z.literal('screen-share-stop') }),
  z.object({ kind: z.literal('e2ee-toggle'), e2ee: z.boolean() }),
  z.object({ kind: z.literal('e2ee-downgrade-request') }),
  z.object({ kind: z.literal('e2ee-downgrade-accept') }),
  z.object({ kind: z.literal('e2ee-downgrade-decline') }),
  z.object({ kind: z.literal('username-set'), username: z.string().min(1).max(24) }),
  z.object({
    kind: z.literal('reaction'),
    msgId: z.string().min(1).max(32),
    emoji: z.string().min(1).max(8),
    action: z.enum(['add', 'remove']),
  }),
  z.object({ kind: z.literal('timed-consumed'), noteId: z.string().min(1) }),
  z.object({
    kind: z.literal('poll'),
    pollId: z.string().min(1).max(32),
    question: z.string().min(1).max(500),
    questionEmoji: z.string().max(8),
    options: z.array(z.object({
      text: z.string().min(1).max(200),
      emoji: z.string().max(8),
    })).min(2).max(20),
    allowMultiple: z.boolean(),
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('poll-vote'),
    pollId: z.string().min(1).max(32),
    optionIndices: z.array(z.number().int().nonnegative().max(19)).min(0).max(20),
  }),
  z.object({
    kind: z.literal('notefade'),
    url: z.string().url(),
    msgId: z.string().min(1).max(32).optional(),
    replyTo: z.string().min(1).max(32).optional(),
    ts: z.number().optional(),
  }),
])

type VoiceHandlerRef = RefObject<((signal: VoiceSignal) => void) | null>

type VoiceNoteMeta = {
  kind: 'voice-note-meta'
  noteId: string
  mimeType: string
  durationMs: number
  totalChunks: number
  totalBytes: number
  timed?: boolean
  ts?: number
}

type VoiceNoteChunk = {
  kind: 'voice-note-chunk'
  noteId: string
  index: number
  data: string
}

type VoiceNoteComplete = {
  kind: 'voice-note-complete'
  noteId: string
}

type VoiceNotePayload = VoiceNoteMeta | VoiceNoteChunk | VoiceNoteComplete

type FileTransferMeta = {
  kind: 'file-meta'
  fileId: string
  fileName: string
  mimeType: string
  totalChunks: number
  totalBytes: number
  timed?: boolean
  ts?: number
  galleryId?: string
}

type FileTransferChunk = {
  kind: 'file-chunk'
  fileId: string
  index: number
  data: string
  galleryId?: string
}

type FileTransferComplete = {
  kind: 'file-complete'
  fileId: string
  galleryId?: string
}

type FileTransferPayload = FileTransferMeta | FileTransferChunk | FileTransferComplete

interface GalleryMeta {
  kind: 'gallery-meta'
  galleryId: string
  caption?: string
  timed?: boolean
  ts?: number
  images: Array<{
    fileId: string
    fileName: string
    mimeType: string
    totalChunks: number
    totalBytes: number
  }>
}

interface GalleryComplete {
  kind: 'gallery-complete'
  galleryId: string
}

interface GalleryAssembly {
  caption?: string
  timed?: boolean
  ts?: number
  expectedImages: Array<{
    fileId: string
    fileName: string
    mimeType: string
    totalBytes: number
  }>
  completedFileIds: Set<string>
  failedFileIds: Set<string>
  galleryComplete: boolean
  createdAt: number
}

interface FileAssembly {
  fileName: string
  mimeType: string
  totalChunks: number
  totalBytes: number
  receivedBytes: number
  chunks: Map<number, Uint8Array>
  createdAt: number
  timed?: boolean
  ts?: number
}

function fileMaxBytes(mimeType: string): number {
  return IMAGE_MIME_TYPES.has(mimeType) ? FILE_MAX_IMAGE_BYTES : FILE_MAX_GENERAL_BYTES
}

interface VoiceNoteAssembly {
  mimeType: string
  durationMs: number
  totalChunks: number
  totalBytes: number
  receivedBytes: number
  chunks: Map<number, Uint8Array>
  createdAt: number
  timed?: boolean
  ts?: number
}

function generateMessageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return toBase64Url(bytes)
}

export function _chunkBytes(input: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(input.slice(i, i + chunkSize))
  }
  return chunks
}

export function _concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export function _insertSorted(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
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

function buildAudioMessage(
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

function buildTextMessage(
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

function buildFileMessage(
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

function buildNotefadeMessage(
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

function applyReaction(
  messages: ChatMessage[],
  msgId: string,
  emoji: string,
  action: 'add' | 'remove',
  fromSelf: boolean,
): ChatMessage[] {
  return messages.map(msg => {
    if (msg.id !== msgId) return msg
    let reactions = [...msg.reactions]
    if (action === 'add') {
      reactions = reactions.filter(r => r.fromSelf !== fromSelf)
      reactions = [...reactions, { emoji, fromSelf }]
    } else {
      reactions = reactions.filter(r => !(r.emoji === emoji && r.fromSelf === fromSelf))
    }
    return { ...msg, reactions }
  })
}

function findReplyPreview(messages: ChatMessage[], replyTo: string): string | undefined {
  const target = messages.find(m => m.id === replyTo)
  if (!target) return undefined
  if (target.kind === 'audio') return '(voice note)'
  if (target.kind === 'image') return '(image)'
  if (target.kind === 'file') return `(file: ${target.fileName ?? 'unknown'})`
  if (target.kind === 'poll') return '(poll)'
  if (target.kind === 'gallery') return '(photo gallery)'
  if (target.kind === 'notefade') return '(self-destructing note)'
  if (target.timed) return '(timed message)'
  const text = target.text ?? ''
  return text.length > 80 ? text.slice(0, 80) + '...' : text
}

export function _buildPollMessage(
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

export function _applyPollVote(
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

const TYPING_SAFETY_TIMEOUT = 30_000

export function useChatAsCreator(
  existingRoomId: string,
  voiceHandlerRef?: VoiceHandlerRef,
  initialRoomSettings?: RoomSettings | null,
) {
  const [phase, setPhase] = useState<ChatPhase>('creating')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roomSettings, setRoomSettings] = useState<RoomSettings>(() =>
    normalizeRoomSettings(initialRoomSettings ?? DEFAULT_ROOM_SETTINGS),
  )
  const [localUsername, setLocalUsername] = useState<string | null>(null)
  const [peerUsername, setPeerUsername] = useState<string | null>(null)
  const [mediaKeyRaw, setMediaKeyRaw] = useState<Uint8Array | null>(null)

  const wsRef = useRef<ReconnectingChatWebSocket | null>(null)
  const ratchetRef = useRef<RatchetState | null>(null)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)
  const roomIdRef = useRef<string | null>(null)
  const creatorPubKeyRef = useRef<string | null>(null)
  const roomSettingsRef = useRef<RoomSettings>(normalizeRoomSettings(initialRoomSettings ?? DEFAULT_ROOM_SETTINGS))
  const localUsernameRef = useRef<string | null>(null)
  const peerUsernameRef = useRef<string | null>(null)
  const cleanedUpRef = useRef(false)
  const typingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceNoteAssembliesRef = useRef<Map<string, VoiceNoteAssembly>>(new Map())
  const localAudioUrlsRef = useRef<Set<string>>(new Set())
  const fileAssembliesRef = useRef<Map<string, FileAssembly>>(new Map())
  const localFileUrlsRef = useRef<Set<string>>(new Set())
  const galleryAssembliesRef = useRef<Map<string, GalleryAssembly>>(new Map())
  const peerPollVotesRef = useRef<Map<string, number[]>>(new Map())
  const selfPollVotesRef = useRef<Map<string, number[]>>(new Map())

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
  }, [])

  const trackFileUrl = useCallback((url: string) => {
    localFileUrlsRef.current.add(url)
  }, [])

  const setLocalUsernameAndNotify = useCallback(async (username: string) => {
    const trimmed = username.trim().slice(0, 24)
    if (!trimmed) return
    localUsernameRef.current = trimmed
    setLocalUsername(trimmed)
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'username-set', username: trimmed }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const refreshInviteUrl = useCallback((nextSettings: RoomSettings) => {
    const roomId = roomIdRef.current
    const creatorPubKey = creatorPubKeyRef.current
    if (!roomId || !creatorPubKey) return
    const fragment = buildInviteFragment(roomId, creatorPubKey, nextSettings)
    const url = `${window.location.origin}${window.location.pathname}#${fragment}`
    setInviteUrl(url)
    window.location.hash = fragment
  }, [])

  const updateRoomSettings = useCallback((next: RoomSettings) => {
    const normalized = normalizeRoomSettings(next)
    roomSettingsRef.current = normalized
    setRoomSettings(normalized)
    refreshInviteUrl(normalized)
  }, [refreshInviteUrl])

  const cleanupVoiceNoteAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [noteId, assembly] of voiceNoteAssembliesRef.current) {
      if (now - assembly.createdAt > VOICE_NOTE_ASSEMBLY_TIMEOUT_MS) {
        voiceNoteAssembliesRef.current.delete(noteId)
      }
    }
  }, [])

  const onVoiceNotePayload = useCallback((payload: VoiceNotePayload, sender: 'self' | 'peer') => {
    cleanupVoiceNoteAssemblies()
    if (payload.kind === 'voice-note-meta') {
      if (payload.totalBytes > VOICE_NOTE_MAX_BYTES) return
      voiceNoteAssembliesRef.current.set(payload.noteId, {
        mimeType: payload.mimeType,
        durationMs: payload.durationMs,
        totalChunks: payload.totalChunks,
        totalBytes: payload.totalBytes,
        receivedBytes: 0,
        chunks: new Map(),
        createdAt: Date.now(),
        timed: payload.timed || undefined,
        ts: payload.ts,
      })
      return
    }

    if (payload.kind === 'voice-note-chunk') {
      const assembly = voiceNoteAssembliesRef.current.get(payload.noteId)
      if (!assembly) return
      if (payload.index >= assembly.totalChunks) return
      if (assembly.chunks.has(payload.index)) return
      const chunk = fromBase64Url(payload.data)
      const nextSize = assembly.receivedBytes + chunk.length
      if (nextSize > VOICE_NOTE_MAX_BYTES || nextSize > assembly.totalBytes) {
        voiceNoteAssembliesRef.current.delete(payload.noteId)
        return
      }
      assembly.chunks.set(payload.index, chunk)
      assembly.receivedBytes = nextSize
      return
    }

    const assembly = voiceNoteAssembliesRef.current.get(payload.noteId)
    if (!assembly) return
    if (
      assembly.chunks.size !== assembly.totalChunks ||
      assembly.receivedBytes !== assembly.totalBytes
    ) {
      voiceNoteAssembliesRef.current.delete(payload.noteId)
      return
    }

    const orderedChunks: Uint8Array[] = []
    for (let i = 0; i < assembly.totalChunks; i++) {
      const chunk = assembly.chunks.get(i)
      if (!chunk) {
        voiceNoteAssembliesRef.current.delete(payload.noteId)
        return
      }
      orderedChunks.push(chunk)
    }
    const bytes = _concatChunks(orderedChunks)
    const arrayBuffer = new ArrayBuffer(bytes.length)
    new Uint8Array(arrayBuffer).set(bytes)
    const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    const rcvNoteId = payload.noteId
    setMessages(prev => _insertSorted(prev, buildAudioMessage(
      sender,
      objectUrl,
      assembly.durationMs,
      sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
      rcvNoteId,
      assembly.timed,
      assembly.ts,
    )))
    void computeWaveform(blob).then(w => {
      setMessages(prev => prev.map(m => m.id === rcvNoteId ? { ...m, waveform: w } : m))
    })
    voiceNoteAssembliesRef.current.delete(payload.noteId)
  }, [cleanupVoiceNoteAssemblies, trackAudioUrl])

  const cleanupFileAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [fileId, assembly] of fileAssembliesRef.current) {
      if (now - assembly.createdAt > FILE_ASSEMBLY_TIMEOUT_MS) {
        fileAssembliesRef.current.delete(fileId)
        setMessages(prev => prev.filter(m => m.id !== fileId))
      }
    }
  }, [])

  const onFilePayload = useCallback((payload: FileTransferPayload, sender: 'self' | 'peer') => {
    cleanupFileAssemblies()

    // Gallery-routed file: update gallery message instead of standalone
    if (payload.galleryId) {
      const galleryAssembly = galleryAssembliesRef.current.get(payload.galleryId)
      if (!galleryAssembly) return

      if (payload.kind === 'file-meta') {
        const maxBytes = fileMaxBytes(payload.mimeType)
        if (payload.totalBytes > maxBytes) {
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        fileAssembliesRef.current.set(payload.fileId, {
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          totalChunks: payload.totalChunks,
          totalBytes: payload.totalBytes,
          receivedBytes: 0,
          chunks: new Map(),
          createdAt: Date.now(),
        })
        // Update gallery message with per-image progress
        setMessages(prev => prev.map(m => {
          if (m.id !== payload.galleryId || !m.gallery) return m
          return { ...m, gallery: m.gallery.map(gi =>
            gi.fileId === payload.fileId ? { ...gi, transferProgress: 0 } : gi
          )}
        }))
        return
      }

      if (payload.kind === 'file-chunk') {
        const assembly = fileAssembliesRef.current.get(payload.fileId)
        if (!assembly) return
        if (payload.index >= assembly.totalChunks) return
        if (assembly.chunks.has(payload.index)) return
        const chunk = fromBase64Url(payload.data)
        const nextSize = assembly.receivedBytes + chunk.length
        const maxBytes = fileMaxBytes(assembly.mimeType)
        if (nextSize > maxBytes || nextSize > assembly.totalBytes) {
          fileAssembliesRef.current.delete(payload.fileId)
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        assembly.chunks.set(payload.index, chunk)
        assembly.receivedBytes = nextSize
        const progress = assembly.totalBytes > 0 ? nextSize / assembly.totalBytes : 0
        setMessages(prev => prev.map(m => {
          if (m.id !== payload.galleryId || !m.gallery) return m
          return { ...m, gallery: m.gallery.map(gi =>
            gi.fileId === payload.fileId ? { ...gi, transferProgress: progress } : gi
          )}
        }))
        return
      }

      // file-complete for gallery image
      const assembly = fileAssembliesRef.current.get(payload.fileId)
      if (!assembly) {
        galleryAssembly.failedFileIds.add(payload.fileId)
        return
      }
      if (
        assembly.chunks.size !== assembly.totalChunks ||
        assembly.receivedBytes !== assembly.totalBytes
      ) {
        fileAssembliesRef.current.delete(payload.fileId)
        galleryAssembly.failedFileIds.add(payload.fileId)
        return
      }

      const orderedChunks: Uint8Array[] = []
      for (let i = 0; i < assembly.totalChunks; i++) {
        const chunk = assembly.chunks.get(i)
        if (!chunk) {
          fileAssembliesRef.current.delete(payload.fileId)
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        orderedChunks.push(chunk)
      }
      const bytes = _concatChunks(orderedChunks)
      const arrayBuffer = new ArrayBuffer(bytes.length)
      new Uint8Array(arrayBuffer).set(bytes)
      const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
      const objectUrl = URL.createObjectURL(blob)
      trackFileUrl(objectUrl)
      galleryAssembly.completedFileIds.add(payload.fileId)
      fileAssembliesRef.current.delete(payload.fileId)
      setMessages(prev => prev.map(m => {
        if (m.id !== payload.galleryId || !m.gallery) return m
        return { ...m, gallery: m.gallery.map(gi =>
          gi.fileId === payload.fileId ? { ...gi, fileUrl: objectUrl, transferProgress: undefined } : gi
        )}
      }))
      return
    }

    // Standalone file (non-gallery)
    if (payload.kind === 'file-meta') {
      if (fileAssembliesRef.current.size >= FILE_MAX_CONCURRENT_TRANSFERS) return
      const maxBytes = fileMaxBytes(payload.mimeType)
      if (payload.totalBytes > maxBytes) return
      fileAssembliesRef.current.set(payload.fileId, {
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        totalChunks: payload.totalChunks,
        totalBytes: payload.totalBytes,
        receivedBytes: 0,
        chunks: new Map(),
        createdAt: Date.now(),
        timed: payload.timed || undefined,
        ts: payload.ts,
      })
      const msgKind = IMAGE_MIME_TYPES.has(payload.mimeType) ? 'image' as const : 'file' as const
      setMessages(prev => _insertSorted(prev, {
        ...buildFileMessage(
          sender, msgKind, '', payload.fileName,
          payload.mimeType, payload.totalBytes,
          sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
          payload.fileId, payload.timed, payload.ts,
        ),
        transferProgress: 0,
      }))
      return
    }

    if (payload.kind === 'file-chunk') {
      const assembly = fileAssembliesRef.current.get(payload.fileId)
      if (!assembly) return
      if (payload.index >= assembly.totalChunks) return
      if (assembly.chunks.has(payload.index)) return
      const chunk = fromBase64Url(payload.data)
      const nextSize = assembly.receivedBytes + chunk.length
      const maxBytes = fileMaxBytes(assembly.mimeType)
      if (nextSize > maxBytes || nextSize > assembly.totalBytes) {
        fileAssembliesRef.current.delete(payload.fileId)
        setMessages(prev => prev.filter(m => m.id !== payload.fileId))
        return
      }
      assembly.chunks.set(payload.index, chunk)
      assembly.receivedBytes = nextSize
      const progress = assembly.totalBytes > 0 ? nextSize / assembly.totalBytes : 0
      setMessages(prev => prev.map(m =>
        m.id === payload.fileId ? { ...m, transferProgress: progress } : m
      ))
      return
    }

    const assembly = fileAssembliesRef.current.get(payload.fileId)
    if (!assembly) return
    if (
      assembly.chunks.size !== assembly.totalChunks ||
      assembly.receivedBytes !== assembly.totalBytes
    ) {
      fileAssembliesRef.current.delete(payload.fileId)
      setMessages(prev => prev.filter(m => m.id !== payload.fileId))
      return
    }

    const orderedChunks: Uint8Array[] = []
    for (let i = 0; i < assembly.totalChunks; i++) {
      const chunk = assembly.chunks.get(i)
      if (!chunk) {
        fileAssembliesRef.current.delete(payload.fileId)
        setMessages(prev => prev.filter(m => m.id !== payload.fileId))
        return
      }
      orderedChunks.push(chunk)
    }
    const bytes = _concatChunks(orderedChunks)
    const arrayBuffer = new ArrayBuffer(bytes.length)
    new Uint8Array(arrayBuffer).set(bytes)
    const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(blob)
    trackFileUrl(objectUrl)
    const msgKind = IMAGE_MIME_TYPES.has(assembly.mimeType) ? 'image' as const : 'file' as const
    setMessages(prev => prev.map(m =>
      m.id === payload.fileId ? {
        ...buildFileMessage(
          sender, msgKind, objectUrl, assembly.fileName,
          assembly.mimeType, assembly.totalBytes,
          sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
          payload.fileId, assembly.timed, assembly.ts,
        ),
        reactions: m.reactions,
        transferProgress: undefined,
      } : m
    ))
    fileAssembliesRef.current.delete(payload.fileId)
  }, [cleanupFileAssemblies, trackFileUrl])

  const onGalleryPayload = useCallback((data: GalleryMeta | GalleryComplete, sender: 'self' | 'peer') => {
    if (data.kind === 'gallery-meta') {
      if (data.images.length === 0 || data.images.length > GALLERY_MAX_IMAGES) return
      const galleryImages: GalleryImage[] = data.images.map(img => ({
        fileId: img.fileId,
        fileName: img.fileName,
        mimeType: img.mimeType,
        fileSize: img.totalBytes,
      }))
      galleryAssembliesRef.current.set(data.galleryId, {
        caption: data.caption,
        timed: data.timed || undefined,
        ts: data.ts,
        expectedImages: data.images.map(img => ({
          fileId: img.fileId,
          fileName: img.fileName,
          mimeType: img.mimeType,
          totalBytes: img.totalBytes,
        })),
        completedFileIds: new Set(),
        failedFileIds: new Set(),
        galleryComplete: false,
        createdAt: Date.now(),
      })
      setMessages(prev => _insertSorted(prev, {
        id: data.galleryId,
        kind: 'gallery',
        text: data.caption,
        sender,
        displayName: sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
        timestamp: data.ts ?? Date.now(),
        reactions: [],
        timed: data.timed || undefined,
        gallery: galleryImages,
      }))
      return
    }

    // gallery-complete
    const galleryAssembly = galleryAssembliesRef.current.get(data.galleryId)
    if (!galleryAssembly) return
    galleryAssembly.galleryComplete = true

    // If zero images succeeded, remove gallery message
    if (galleryAssembly.completedFileIds.size === 0) {
      setMessages(prev => prev.filter(m => m.id !== data.galleryId))
      galleryAssembliesRef.current.delete(data.galleryId)
      return
    }

    // Remove failed images from gallery
    if (galleryAssembly.failedFileIds.size > 0) {
      setMessages(prev => prev.map(m => {
        if (m.id !== data.galleryId || !m.gallery) return m
        const filtered = m.gallery.filter(gi => !galleryAssembly.failedFileIds.has(gi.fileId))
        return filtered.length > 0 ? { ...m, gallery: filtered } : m
      }))
    }
    galleryAssembliesRef.current.delete(data.galleryId)
  }, [])

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return
    cleanedUpRef.current = true
    if (typingSafetyRef.current) {
      clearTimeout(typingSafetyRef.current)
      typingSafetyRef.current = null
    }
    if (ratchetRef.current) {
      destroyState(ratchetRef.current)
      ratchetRef.current = null
    }
    voiceNoteAssembliesRef.current.clear()
    fileAssembliesRef.current.clear()
    galleryAssembliesRef.current.clear()
    for (const url of localAudioUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localAudioUrlsRef.current.clear()
    for (const url of localFileUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localFileUrlsRef.current.clear()
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null
      ws.cancelReconnect()
      try { ws.send({ type: 'leave' }) } catch { /* ignore */ }
      setTimeout(() => ws.close(), 100)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    cleanedUpRef.current = false

    async function start() {
      try {
        const kp = await generateKeyPair()
        if (cancelled) return
        keyPairRef.current = kp

        // Use the room already created by Home.tsx — don't create another one
        const roomId = existingRoomId
        roomIdRef.current = roomId

        const pubKeyRaw = await exportPublicKey(kp.publicKey)
        const pubKeyB64 = toBase64Url(pubKeyRaw)
        creatorPubKeyRef.current = pubKeyB64
        const fragment = buildInviteFragment(roomId, pubKeyB64, roomSettingsRef.current)
        const url = `${window.location.origin}${window.location.pathname}#${fragment}`
        setInviteUrl(url)
        window.location.hash = fragment

        // Mark as creator in sessionStorage
        sessionStorage.setItem(`yapgone-creator-${roomId}`, '1')

        setPhase('waiting')

        // Connect WebSocket
        const ws = createReconnectingWebSocket()
        wsRef.current = ws

        ws.onOpen = () => {
          if (cancelled) return
          setPhase('waiting')
        }

        ws.onMessage = async (msg) => {
          if (cancelled) return
          await handleCreatorMessage(msg, kp)
        }

        ws.onClose = (_code, reason) => {
          if (cancelled) return
          if (reason === 'Room expired') {
            setPhase('expired')
          }
        }

        ws.onError = () => {
          if (cancelled) return
          setError('Connection failed')
          setPhase('error')
        }

        ws.onReconnecting = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Connection lost, reconnecting...')])
        }

        ws.onReconnected = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Reconnected')])
        }

        ws.onReconnectFailed = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Failed to reconnect')])
          setError('Connection lost')
          setPhase('error')
        }

        ws.connect(buildWsUrl(roomId))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown error')
        setPhase('error')
      }
    }

    async function handleCreatorMessage(msg: ServerMessage | ClientMessage, kp: CryptoKeyPair) {
      if (msg.type === 'peer-joined') {
        setPhase(prev => {
          if (prev === 'peer-disconnected') {
            setMessages(p => [...p, buildTextMessage('system', 'Your partner reconnected')])
            return 'ready'
          }
          return 'key-exchange'
        })
        return
      }

      if (msg.type === 'peer-left') {
        setMessages(prev => [...prev, buildTextMessage('system', 'Your partner disconnected')])
        setPhase('peer-disconnected')
        return
      }

      if (msg.type === 'room-expired') {
        setPhase('expired')
        return
      }

      if (msg.type === 'room-closed') {
        setPhase('room-closed')
        return
      }

      if (msg.type === 'error') {
        setError(msg.message)
        setPhase('error')
        return
      }

      // Relayed client messages
      if (msg.type === 'pubkey') {
        try {
          const remotePubKeyRaw = fromBase64Url(msg.key)
          const remotePubKey = await importPublicKey(remotePubKeyRaw)
          const sharedSecret = await deriveSharedSecret(kp.privateKey, remotePubKey)
          const rootKey = await hkdfDerive(sharedSecret, SALT, INFO, 32)
          ratchetRef.current = await initCreator(kp, rootKey)
          setMediaKeyRaw(await deriveMediaKeyRaw(rootKey))
          setPhase('ready')
        } catch {
          setError('Key exchange failed')
          setPhase('error')
        }
        return
      }

      if (msg.type === 'message') {
        if (!ratchetRef.current) return
        try {
          const payloadBytes = fromBase64Url(msg.payload)
          const iv = payloadBytes.slice(0, 12)
          const ciphertext = payloadBytes.slice(12)
          const { state: newState, plaintext } = await ratchetDecrypt(
            ratchetRef.current,
            msg.header,
            iv,
            ciphertext,
          )
          ratchetRef.current = newState
          const decoded = new TextDecoder().decode(plaintext)
          const parsed: unknown = JSON.parse(decoded)
          const result = DecryptedPayloadSchema.safeParse(parsed)
          if (!result.success) return
          const data = result.data
          if (data.kind === 'text') {
            const id = data.msgId ?? generateMessageId()
            const content = data.content
            const replyToId = data.replyTo
            const peerTs = data.ts
            setMessages(prev => {
              const replyPreview = replyToId
                ? findReplyPreview(prev, replyToId)
                : undefined
              return _insertSorted(prev, {
                ...buildTextMessage('peer', content, peerUsernameRef.current ?? undefined, id, peerTs),
                replyTo: replyToId,
                replyPreview,
                timed: data.timed || undefined,
              })
            })
          } else if (data.kind === 'reaction') {
            const { msgId, emoji, action } = data
            setMessages(prev => applyReaction(prev, msgId, emoji, action, false))
          } else if (data.kind === 'username-set') {
            const nextPeerUsername = data.username.trim().slice(0, 24)
            if (!nextPeerUsername) return
            peerUsernameRef.current = nextPeerUsername
            setPeerUsername(nextPeerUsername)
          } else if (
            data.kind === 'voice-note-meta' ||
            data.kind === 'voice-note-chunk' ||
            data.kind === 'voice-note-complete'
          ) {
            onVoiceNotePayload(data, 'peer')
          } else if (
            data.kind === 'file-meta' ||
            data.kind === 'file-chunk' ||
            data.kind === 'file-complete'
          ) {
            onFilePayload(data, 'peer')
          } else if (data.kind === 'timed-consumed') {
            setMessages(prev => prev.map(msg =>
              msg.id === data.noteId ? { ...msg, timedConsumed: true } : msg
            ))
          } else if (
            data.kind === 'gallery-meta' ||
            data.kind === 'gallery-complete'
          ) {
            onGalleryPayload(data, 'peer')
          } else if (data.kind === 'poll') {
            setMessages(prev => _insertSorted(prev, _buildPollMessage(
              'peer', data.pollId, data.question, data.questionEmoji,
              data.options, data.allowMultiple,
              peerUsernameRef.current ?? undefined, data.ts,
            )))
          } else if (data.kind === 'poll-vote') {
            const previous = peerPollVotesRef.current.get(data.pollId) ?? []
            setMessages(prev => _applyPollVote(prev, data.pollId, data.optionIndices, false, previous))
            peerPollVotesRef.current.set(data.pollId, data.optionIndices)
          } else if (data.kind === 'notefade') {
            const id = data.msgId ?? generateMessageId()
            setMessages(prev => {
              const replyPreview = data.replyTo ? findReplyPreview(prev, data.replyTo) : undefined
              return _insertSorted(prev, {
                ...buildNotefadeMessage('peer', data.url, peerUsernameRef.current ?? undefined, id, data.ts),
                replyTo: data.replyTo,
                replyPreview,
              })
            })
          } else {
            voiceHandlerRef?.current?.(data)
          }
        } catch {
          // Decryption or parse failed — ignore
        }
        return
      }

      if (msg.type === 'typing') {
        if (typingSafetyRef.current) {
          clearTimeout(typingSafetyRef.current)
          typingSafetyRef.current = null
        }
        if (msg.active) {
          setPeerTyping(true)
          typingSafetyRef.current = setTimeout(() => {
            setPeerTyping(false)
          }, TYPING_SAFETY_TIMEOUT)
        } else {
          setPeerTyping(false)
        }
        return
      }
    }

    start()

    return () => {
      cancelled = true
      cleanup()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (text: string, replyTo?: string, timed?: boolean) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const msgId = generateMessageId()
    const ts = Date.now()
    const payloadObj: Record<string, unknown> = { kind: 'text', content: trimmed, msgId, ts }
    if (replyTo) payloadObj.replyTo = replyTo
    if (timed) payloadObj.timed = true

    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState

    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    setMessages(prev => {
      const replyPreview = replyTo ? findReplyPreview(prev, replyTo) : undefined
      return _insertSorted(prev, {
        ...buildTextMessage('self', trimmed, localUsernameRef.current ?? undefined, msgId, ts),
        replyTo,
        replyPreview,
        timed: timed || undefined,
      })
    })
  }, [])

  const sendNotefade = useCallback(async (url: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const msgId = generateMessageId()
    const ts = Date.now()
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'notefade', url, msgId, ts,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    setMessages(prev => _insertSorted(prev, buildNotefadeMessage(
      'self', url, localUsernameRef.current ?? undefined, msgId, ts,
    )))
  }, [])

  const sendReaction = useCallback(async (msgId: string, emoji: string, action: 'add' | 'remove') => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'reaction', msgId, emoji, action }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    // Optimistic local update
    setMessages(prev => applyReaction(prev, msgId, emoji, action, true))
  }, [])

  const removeTimedMessage = useCallback((targetMsgId: string) => {
    setMessages(prev => prev.filter(msg => msg.id !== targetMsgId))
  }, [])

  const sendVoiceSignal = useCallback(async (signal: VoiceSignal) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(JSON.stringify(signal))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const sendVoiceNote = useCallback(async (
    blob: Blob,
    durationMs: number,
    mimeType: string,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0 || bytes.length > VOICE_NOTE_MAX_BYTES) return

    const noteId = generateMessageId()
    const ts = Date.now()
    const chunks = _chunkBytes(bytes, VOICE_NOTE_CHUNK_BYTES)
    const meta: VoiceNoteMeta = {
      kind: 'voice-note-meta',
      noteId,
      mimeType,
      durationMs,
      totalChunks: chunks.length,
      totalBytes: bytes.length,
      timed: timed || undefined,
      ts,
    }
    const messages: VoiceNotePayload[] = [
      meta,
      ...chunks.map((chunk, index): VoiceNoteChunk => ({
        kind: 'voice-note-chunk',
        noteId,
        index,
        data: toBase64Url(chunk),
      })),
      { kind: 'voice-note-complete', noteId },
    ]

    for (const message of messages) {
      const plaintext = new TextEncoder().encode(JSON.stringify(message))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
        ratchetRef.current,
        plaintext,
      )
      ratchetRef.current = newState
      const payload = toBase64Url(concatBytes(iv, ciphertext))
      wsRef.current.send({ type: 'message', header, payload })
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    setMessages(prev => _insertSorted(prev, buildAudioMessage(
      'self',
      objectUrl,
      durationMs,
      localUsernameRef.current ?? undefined,
      noteId,
      timed,
      ts,
    )))
    void computeWaveform(blob).then(w => {
      setMessages(prev => prev.map(m => m.id === noteId ? { ...m, waveform: w } : m))
    })
  }, [trackAudioUrl])

  const sendFile = useCallback(async (
    file: File,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const maxBytes = fileMaxBytes(file.type)
    if (bytes.length === 0 || bytes.length > maxBytes) return

    const fileId = generateMessageId()
    const ts = Date.now()
    const chunks = _chunkBytes(bytes, FILE_CHUNK_BYTES)
    const meta: FileTransferMeta = {
      kind: 'file-meta',
      fileId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: chunks.length,
      totalBytes: bytes.length,
      timed: timed || undefined,
      ts,
    }
    const payloads: FileTransferPayload[] = [
      meta,
      ...chunks.map((chunk, index): FileTransferChunk => ({
        kind: 'file-chunk',
        fileId,
        index,
        data: toBase64Url(chunk),
      })),
      { kind: 'file-complete', fileId },
    ]

    // Show local message immediately with progress
    const objectUrl = URL.createObjectURL(file)
    trackFileUrl(objectUrl)
    const msgKind = IMAGE_MIME_TYPES.has(file.type) ? 'image' as const : 'file' as const
    setMessages(prev => _insertSorted(prev, {
      ...buildFileMessage(
        'self', msgKind, objectUrl, file.name,
        file.type || 'application/octet-stream', bytes.length,
        localUsernameRef.current ?? undefined,
        fileId, timed, ts,
      ),
      transferProgress: 0,
    }))

    for (let i = 0; i < payloads.length; i++) {
      const message = payloads[i]
      if (!message) continue
      const plaintext = new TextEncoder().encode(JSON.stringify(message))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
        ratchetRef.current,
        plaintext,
      )
      ratchetRef.current = newState
      const encPayload = toBase64Url(concatBytes(iv, ciphertext))
      wsRef.current.send({ type: 'message', header, payload: encPayload })
      // Update progress (skip meta and complete messages)
      if (message.kind === 'file-chunk') {
        const progress = (i) / (payloads.length - 1)
        setMessages(prev => prev.map(m =>
          m.id === fileId ? { ...m, transferProgress: progress } : m
        ))
      }
      await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
    }

    // Mark transfer complete
    setMessages(prev => prev.map(m =>
      m.id === fileId ? { ...m, transferProgress: undefined } : m
    ))
  }, [trackFileUrl])

  const sendTimedConsumed = useCallback(async (noteId: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'timed-consumed', noteId }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const sendPoll = useCallback(async (
    question: string,
    questionEmoji: string,
    options: Array<{ text: string; emoji: string }>,
    allowMultiple: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const pollId = generateMessageId()
    const ts = Date.now()
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'poll', pollId, question, questionEmoji, options, allowMultiple, ts,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    setMessages(prev => _insertSorted(prev, _buildPollMessage(
      'self', pollId, question, questionEmoji, options, allowMultiple,
      localUsernameRef.current ?? undefined, ts,
    )))
  }, [])

  const sendPollVote = useCallback(async (pollId: string, optionIndices: number[]) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'poll-vote', pollId, optionIndices,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    const previous = selfPollVotesRef.current.get(pollId) ?? []
    setMessages(prev => _applyPollVote(prev, pollId, optionIndices, true, previous))
    selfPollVotesRef.current.set(pollId, optionIndices)
  }, [])

  const sendGallery = useCallback(async (
    files: File[],
    caption?: string,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const validFiles = files.slice(0, GALLERY_MAX_IMAGES).filter(f =>
      f.size > 0 && f.size <= FILE_MAX_IMAGE_BYTES && IMAGE_MIME_TYPES.has(f.type)
    )
    if (validFiles.length === 0) return

    const galleryId = generateMessageId()
    const ts = Date.now()

    // Prepare per-image data
    const imageEntries = await Promise.all(validFiles.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const fileId = generateMessageId()
      const chunks = _chunkBytes(bytes, FILE_CHUNK_BYTES)
      const objectUrl = URL.createObjectURL(file)
      trackFileUrl(objectUrl)
      return { file, bytes, fileId, chunks, objectUrl }
    }))

    // Send gallery-meta
    const galleryMeta: GalleryMeta = {
      kind: 'gallery-meta',
      galleryId,
      caption: caption || undefined,
      timed: timed || undefined,
      ts,
      images: imageEntries.map(e => ({
        fileId: e.fileId,
        fileName: e.file.name,
        mimeType: e.file.type,
        totalChunks: e.chunks.length,
        totalBytes: e.bytes.length,
      })),
    }
    {
      const plaintext = new TextEncoder().encode(JSON.stringify(galleryMeta))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
      ratchetRef.current = newState
      wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
    }

    // Show local gallery message immediately
    setMessages(prev => _insertSorted(prev, {
      id: galleryId,
      kind: 'gallery',
      text: caption || undefined,
      sender: 'self',
      displayName: localUsernameRef.current ?? undefined,
      timestamp: ts,
      reactions: [],
      timed: timed || undefined,
      gallery: imageEntries.map(e => ({
        fileId: e.fileId,
        fileUrl: e.objectUrl,
        fileName: e.file.name,
        mimeType: e.file.type,
        fileSize: e.bytes.length,
      })),
    }))

    // Send each image sequentially using existing file-meta/chunk/complete with galleryId
    for (const entry of imageEntries) {
      const meta: FileTransferMeta = {
        kind: 'file-meta',
        fileId: entry.fileId,
        fileName: entry.file.name,
        mimeType: entry.file.type,
        totalChunks: entry.chunks.length,
        totalBytes: entry.bytes.length,
        galleryId,
      }
      const payloads: FileTransferPayload[] = [
        meta,
        ...entry.chunks.map((chunk, index): FileTransferChunk => ({
          kind: 'file-chunk',
          fileId: entry.fileId,
          index,
          data: toBase64Url(chunk),
          galleryId,
        })),
        { kind: 'file-complete', fileId: entry.fileId, galleryId },
      ]

      for (const message of payloads) {
        const plaintext = new TextEncoder().encode(JSON.stringify(message))
        const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
        ratchetRef.current = newState
        wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
        await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
      }
    }

    // Send gallery-complete
    const galleryComplete: GalleryComplete = { kind: 'gallery-complete', galleryId }
    {
      const plaintext = new TextEncoder().encode(JSON.stringify(galleryComplete))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
      ratchetRef.current = newState
      wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
    }
  }, [trackFileUrl])

  const sendTyping = useCallback((active: boolean) => {
    wsRef.current?.send({ type: 'typing', active })
  }, [])

  const endChat = useCallback(() => {
    wsRef.current?.cancelReconnect()
    cleanup()
    setPhase('peer-left')
    window.location.hash = ''
  }, [cleanup])

  const endChatForAll = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.cancelReconnect()
      try { wsRef.current.send({ type: 'close-room' }) } catch { /* ignore */ }
    }
    cleanup()
    setPhase('room-closed')
    window.location.hash = ''
  }, [cleanup])

  return {
    phase,
    messages,
    peerTyping,
    inviteUrl,
    sendMessage,
    sendReaction,
    removeTimedMessage,
    sendTimedConsumed,
    sendNotefade,
    sendPoll,
    sendPollVote,
    sendGallery,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    sendFile,
    endChat,
    endChatForAll,
    roomSettings,
    updateRoomSettings,
    usernameModeEnabled: roomSettings.usernameModeEnabled,
    localUsername,
    peerUsername,
    setLocalUsername: setLocalUsernameAndNotify,
    mediaKeyRaw,
    error,
  }
}

export function useChatAsJoiner(
  roomId: string,
  creatorPubKeyB64: string,
  roomSettings?: RoomSettings | null,
  voiceHandlerRef?: VoiceHandlerRef,
) {
  const [phase, setPhase] = useState<ChatPhase>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localUsername, setLocalUsername] = useState<string | null>(null)
  const [peerUsername, setPeerUsername] = useState<string | null>(null)
  const [mediaKeyRaw, setMediaKeyRaw] = useState<Uint8Array | null>(null)
  const [resolvedRoomSettings] = useState<RoomSettings>(
    normalizeRoomSettings(roomSettings ?? DEFAULT_ROOM_SETTINGS),
  )

  const wsRef = useRef<ReconnectingChatWebSocket | null>(null)
  const ratchetRef = useRef<RatchetState | null>(null)
  const localUsernameRef = useRef<string | null>(null)
  const peerUsernameRef = useRef<string | null>(null)
  const cleanedUpRef = useRef(false)
  const typingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceNoteAssembliesRef = useRef<Map<string, VoiceNoteAssembly>>(new Map())
  const localAudioUrlsRef = useRef<Set<string>>(new Set())
  const fileAssembliesRef = useRef<Map<string, FileAssembly>>(new Map())
  const localFileUrlsRef = useRef<Set<string>>(new Set())
  const galleryAssembliesRef = useRef<Map<string, GalleryAssembly>>(new Map())
  const peerPollVotesRef = useRef<Map<string, number[]>>(new Map())
  const selfPollVotesRef = useRef<Map<string, number[]>>(new Map())

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
  }, [])

  const trackFileUrl = useCallback((url: string) => {
    localFileUrlsRef.current.add(url)
  }, [])

  const setLocalUsernameAndNotify = useCallback(async (username: string) => {
    const trimmed = username.trim().slice(0, 24)
    if (!trimmed) return
    localUsernameRef.current = trimmed
    setLocalUsername(trimmed)
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'username-set', username: trimmed }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const cleanupVoiceNoteAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [noteId, assembly] of voiceNoteAssembliesRef.current) {
      if (now - assembly.createdAt > VOICE_NOTE_ASSEMBLY_TIMEOUT_MS) {
        voiceNoteAssembliesRef.current.delete(noteId)
      }
    }
  }, [])

  const onVoiceNotePayload = useCallback((payload: VoiceNotePayload, sender: 'self' | 'peer') => {
    cleanupVoiceNoteAssemblies()
    if (payload.kind === 'voice-note-meta') {
      if (payload.totalBytes > VOICE_NOTE_MAX_BYTES) return
      voiceNoteAssembliesRef.current.set(payload.noteId, {
        mimeType: payload.mimeType,
        durationMs: payload.durationMs,
        totalChunks: payload.totalChunks,
        totalBytes: payload.totalBytes,
        receivedBytes: 0,
        chunks: new Map(),
        createdAt: Date.now(),
        timed: payload.timed || undefined,
        ts: payload.ts,
      })
      return
    }

    if (payload.kind === 'voice-note-chunk') {
      const assembly = voiceNoteAssembliesRef.current.get(payload.noteId)
      if (!assembly) return
      if (payload.index >= assembly.totalChunks) return
      if (assembly.chunks.has(payload.index)) return
      const chunk = fromBase64Url(payload.data)
      const nextSize = assembly.receivedBytes + chunk.length
      if (nextSize > VOICE_NOTE_MAX_BYTES || nextSize > assembly.totalBytes) {
        voiceNoteAssembliesRef.current.delete(payload.noteId)
        return
      }
      assembly.chunks.set(payload.index, chunk)
      assembly.receivedBytes = nextSize
      return
    }

    const assembly = voiceNoteAssembliesRef.current.get(payload.noteId)
    if (!assembly) return
    if (
      assembly.chunks.size !== assembly.totalChunks ||
      assembly.receivedBytes !== assembly.totalBytes
    ) {
      voiceNoteAssembliesRef.current.delete(payload.noteId)
      return
    }

    const orderedChunks: Uint8Array[] = []
    for (let i = 0; i < assembly.totalChunks; i++) {
      const chunk = assembly.chunks.get(i)
      if (!chunk) {
        voiceNoteAssembliesRef.current.delete(payload.noteId)
        return
      }
      orderedChunks.push(chunk)
    }
    const bytes = _concatChunks(orderedChunks)
    const arrayBuffer = new ArrayBuffer(bytes.length)
    new Uint8Array(arrayBuffer).set(bytes)
    const noteBlob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(noteBlob)
    trackAudioUrl(objectUrl)
    const rcvNoteId2 = payload.noteId
    setMessages(prev => _insertSorted(prev, buildAudioMessage(
      sender,
      objectUrl,
      assembly.durationMs,
      sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
      rcvNoteId2,
      assembly.timed,
      assembly.ts,
    )))
    void computeWaveform(noteBlob).then(w => {
      setMessages(prev => prev.map(m => m.id === rcvNoteId2 ? { ...m, waveform: w } : m))
    })
    voiceNoteAssembliesRef.current.delete(payload.noteId)
  }, [cleanupVoiceNoteAssemblies, trackAudioUrl])

  const cleanupFileAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [fileId, assembly] of fileAssembliesRef.current) {
      if (now - assembly.createdAt > FILE_ASSEMBLY_TIMEOUT_MS) {
        fileAssembliesRef.current.delete(fileId)
        setMessages(prev => prev.filter(m => m.id !== fileId))
      }
    }
  }, [])

  const onFilePayload = useCallback((payload: FileTransferPayload, sender: 'self' | 'peer') => {
    cleanupFileAssemblies()

    // Gallery-routed file
    if (payload.galleryId) {
      const galleryAssembly = galleryAssembliesRef.current.get(payload.galleryId)
      if (!galleryAssembly) return

      if (payload.kind === 'file-meta') {
        const maxBytes = fileMaxBytes(payload.mimeType)
        if (payload.totalBytes > maxBytes) {
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        fileAssembliesRef.current.set(payload.fileId, {
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          totalChunks: payload.totalChunks,
          totalBytes: payload.totalBytes,
          receivedBytes: 0,
          chunks: new Map(),
          createdAt: Date.now(),
        })
        setMessages(prev => prev.map(m => {
          if (m.id !== payload.galleryId || !m.gallery) return m
          return { ...m, gallery: m.gallery.map(gi =>
            gi.fileId === payload.fileId ? { ...gi, transferProgress: 0 } : gi
          )}
        }))
        return
      }

      if (payload.kind === 'file-chunk') {
        const assembly = fileAssembliesRef.current.get(payload.fileId)
        if (!assembly) return
        if (payload.index >= assembly.totalChunks) return
        if (assembly.chunks.has(payload.index)) return
        const chunk = fromBase64Url(payload.data)
        const nextSize = assembly.receivedBytes + chunk.length
        const maxBytes = fileMaxBytes(assembly.mimeType)
        if (nextSize > maxBytes || nextSize > assembly.totalBytes) {
          fileAssembliesRef.current.delete(payload.fileId)
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        assembly.chunks.set(payload.index, chunk)
        assembly.receivedBytes = nextSize
        const progress = assembly.totalBytes > 0 ? nextSize / assembly.totalBytes : 0
        setMessages(prev => prev.map(m => {
          if (m.id !== payload.galleryId || !m.gallery) return m
          return { ...m, gallery: m.gallery.map(gi =>
            gi.fileId === payload.fileId ? { ...gi, transferProgress: progress } : gi
          )}
        }))
        return
      }

      // file-complete for gallery image
      const assembly = fileAssembliesRef.current.get(payload.fileId)
      if (!assembly) {
        galleryAssembly.failedFileIds.add(payload.fileId)
        return
      }
      if (
        assembly.chunks.size !== assembly.totalChunks ||
        assembly.receivedBytes !== assembly.totalBytes
      ) {
        fileAssembliesRef.current.delete(payload.fileId)
        galleryAssembly.failedFileIds.add(payload.fileId)
        return
      }

      const orderedChunks: Uint8Array[] = []
      for (let i = 0; i < assembly.totalChunks; i++) {
        const chunk = assembly.chunks.get(i)
        if (!chunk) {
          fileAssembliesRef.current.delete(payload.fileId)
          galleryAssembly.failedFileIds.add(payload.fileId)
          return
        }
        orderedChunks.push(chunk)
      }
      const bytes = _concatChunks(orderedChunks)
      const arrayBuffer2 = new ArrayBuffer(bytes.length)
      new Uint8Array(arrayBuffer2).set(bytes)
      const blob = new Blob([arrayBuffer2], { type: assembly.mimeType })
      const objectUrl = URL.createObjectURL(blob)
      trackFileUrl(objectUrl)
      galleryAssembly.completedFileIds.add(payload.fileId)
      fileAssembliesRef.current.delete(payload.fileId)
      setMessages(prev => prev.map(m => {
        if (m.id !== payload.galleryId || !m.gallery) return m
        return { ...m, gallery: m.gallery.map(gi =>
          gi.fileId === payload.fileId ? { ...gi, fileUrl: objectUrl, transferProgress: undefined } : gi
        )}
      }))
      return
    }

    // Standalone file (non-gallery)
    if (payload.kind === 'file-meta') {
      if (fileAssembliesRef.current.size >= FILE_MAX_CONCURRENT_TRANSFERS) return
      const maxBytes = fileMaxBytes(payload.mimeType)
      if (payload.totalBytes > maxBytes) return
      fileAssembliesRef.current.set(payload.fileId, {
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        totalChunks: payload.totalChunks,
        totalBytes: payload.totalBytes,
        receivedBytes: 0,
        chunks: new Map(),
        createdAt: Date.now(),
        timed: payload.timed || undefined,
        ts: payload.ts,
      })
      const msgKind = IMAGE_MIME_TYPES.has(payload.mimeType) ? 'image' as const : 'file' as const
      setMessages(prev => _insertSorted(prev, {
        ...buildFileMessage(
          sender, msgKind, '', payload.fileName,
          payload.mimeType, payload.totalBytes,
          sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
          payload.fileId, payload.timed, payload.ts,
        ),
        transferProgress: 0,
      }))
      return
    }

    if (payload.kind === 'file-chunk') {
      const assembly = fileAssembliesRef.current.get(payload.fileId)
      if (!assembly) return
      if (payload.index >= assembly.totalChunks) return
      if (assembly.chunks.has(payload.index)) return
      const chunk = fromBase64Url(payload.data)
      const nextSize = assembly.receivedBytes + chunk.length
      const maxBytes = fileMaxBytes(assembly.mimeType)
      if (nextSize > maxBytes || nextSize > assembly.totalBytes) {
        fileAssembliesRef.current.delete(payload.fileId)
        setMessages(prev => prev.filter(m => m.id !== payload.fileId))
        return
      }
      assembly.chunks.set(payload.index, chunk)
      assembly.receivedBytes = nextSize
      const progress = assembly.totalBytes > 0 ? nextSize / assembly.totalBytes : 0
      setMessages(prev => prev.map(m =>
        m.id === payload.fileId ? { ...m, transferProgress: progress } : m
      ))
      return
    }

    const assembly = fileAssembliesRef.current.get(payload.fileId)
    if (!assembly) return
    if (
      assembly.chunks.size !== assembly.totalChunks ||
      assembly.receivedBytes !== assembly.totalBytes
    ) {
      fileAssembliesRef.current.delete(payload.fileId)
      setMessages(prev => prev.filter(m => m.id !== payload.fileId))
      return
    }

    const orderedChunks: Uint8Array[] = []
    for (let i = 0; i < assembly.totalChunks; i++) {
      const chunk = assembly.chunks.get(i)
      if (!chunk) {
        fileAssembliesRef.current.delete(payload.fileId)
        setMessages(prev => prev.filter(m => m.id !== payload.fileId))
        return
      }
      orderedChunks.push(chunk)
    }
    const bytes = _concatChunks(orderedChunks)
    const arrayBuffer2 = new ArrayBuffer(bytes.length)
    new Uint8Array(arrayBuffer2).set(bytes)
    const fileBlob = new Blob([arrayBuffer2], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(fileBlob)
    trackFileUrl(objectUrl)
    const msgKind = IMAGE_MIME_TYPES.has(assembly.mimeType) ? 'image' as const : 'file' as const
    setMessages(prev => prev.map(m =>
      m.id === payload.fileId ? {
        ...buildFileMessage(
          sender, msgKind, objectUrl, assembly.fileName,
          assembly.mimeType, assembly.totalBytes,
          sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
          payload.fileId, assembly.timed, assembly.ts,
        ),
        reactions: m.reactions,
        transferProgress: undefined,
      } : m
    ))
    fileAssembliesRef.current.delete(payload.fileId)
  }, [cleanupFileAssemblies, trackFileUrl])

  const onGalleryPayload = useCallback((data: GalleryMeta | GalleryComplete, sender: 'self' | 'peer') => {
    if (data.kind === 'gallery-meta') {
      if (data.images.length === 0 || data.images.length > GALLERY_MAX_IMAGES) return
      const galleryImages: GalleryImage[] = data.images.map(img => ({
        fileId: img.fileId,
        fileName: img.fileName,
        mimeType: img.mimeType,
        fileSize: img.totalBytes,
      }))
      galleryAssembliesRef.current.set(data.galleryId, {
        caption: data.caption,
        timed: data.timed || undefined,
        ts: data.ts,
        expectedImages: data.images.map(img => ({
          fileId: img.fileId,
          fileName: img.fileName,
          mimeType: img.mimeType,
          totalBytes: img.totalBytes,
        })),
        completedFileIds: new Set(),
        failedFileIds: new Set(),
        galleryComplete: false,
        createdAt: Date.now(),
      })
      setMessages(prev => _insertSorted(prev, {
        id: data.galleryId,
        kind: 'gallery',
        text: data.caption,
        sender,
        displayName: sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
        timestamp: data.ts ?? Date.now(),
        reactions: [],
        timed: data.timed || undefined,
        gallery: galleryImages,
      }))
      return
    }

    // gallery-complete
    const galleryAssembly = galleryAssembliesRef.current.get(data.galleryId)
    if (!galleryAssembly) return
    galleryAssembly.galleryComplete = true

    if (galleryAssembly.completedFileIds.size === 0) {
      setMessages(prev => prev.filter(m => m.id !== data.galleryId))
      galleryAssembliesRef.current.delete(data.galleryId)
      return
    }

    if (galleryAssembly.failedFileIds.size > 0) {
      setMessages(prev => prev.map(m => {
        if (m.id !== data.galleryId || !m.gallery) return m
        const filtered = m.gallery.filter(gi => !galleryAssembly.failedFileIds.has(gi.fileId))
        return filtered.length > 0 ? { ...m, gallery: filtered } : m
      }))
    }
    galleryAssembliesRef.current.delete(data.galleryId)
  }, [])

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return
    cleanedUpRef.current = true
    if (typingSafetyRef.current) {
      clearTimeout(typingSafetyRef.current)
      typingSafetyRef.current = null
    }
    if (ratchetRef.current) {
      destroyState(ratchetRef.current)
      ratchetRef.current = null
    }
    voiceNoteAssembliesRef.current.clear()
    fileAssembliesRef.current.clear()
    galleryAssembliesRef.current.clear()
    for (const url of localAudioUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localAudioUrlsRef.current.clear()
    for (const url of localFileUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localFileUrlsRef.current.clear()
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null
      ws.cancelReconnect()
      try { ws.send({ type: 'leave' }) } catch { /* ignore */ }
      setTimeout(() => ws.close(), 100)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    cleanedUpRef.current = false

    async function start() {
      try {
        setPhase('connecting')

        const kp = await generateKeyPair()
        if (cancelled) return

        const creatorPubKeyRaw = fromBase64Url(creatorPubKeyB64)
        const creatorPubKey = await importPublicKey(creatorPubKeyRaw)

        // Derive shared secret and init ratchet
        const sharedSecret = await deriveSharedSecret(kp.privateKey, creatorPubKey)
        const rootKey = await hkdfDerive(sharedSecret, SALT, INFO, 32)
        ratchetRef.current = await initJoiner(kp, creatorPubKey, rootKey)
        setMediaKeyRaw(await deriveMediaKeyRaw(rootKey))

        if (cancelled) return

        // Connect WebSocket
        const ws = createReconnectingWebSocket()
        wsRef.current = ws

        ws.onOpen = async () => {
          if (cancelled) return
          // Send our public key
          const myPubKeyRaw = await exportPublicKey(kp.publicKey)
          ws.send({ type: 'pubkey', key: toBase64Url(myPubKeyRaw) })
          setPhase('ready')
        }

        ws.onMessage = async (msg) => {
          if (cancelled) return
          await handleJoinerMessage(msg)
        }

        ws.onClose = (_code, reason) => {
          if (cancelled) return
          if (reason === 'Room expired') {
            setPhase('expired')
          }
        }

        ws.onError = () => {
          if (cancelled) return
          setError('Connection failed')
          setPhase('error')
        }

        ws.onReconnecting = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Connection lost, reconnecting...')])
        }

        ws.onReconnected = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Reconnected')])
        }

        ws.onReconnectFailed = () => {
          if (cancelled) return
          setMessages(prev => [...prev, buildTextMessage('system', 'Failed to reconnect')])
          setError('Connection lost')
          setPhase('error')
        }

        ws.connect(buildWsUrl(roomId))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown error')
        setPhase('error')
      }
    }

    async function handleJoinerMessage(msg: ServerMessage | ClientMessage) {
      if (msg.type === 'peer-joined') {
        setPhase(prev => {
          if (prev === 'peer-disconnected') {
            setMessages(p => [...p, buildTextMessage('system', 'Your partner reconnected')])
            return 'ready'
          }
          return prev
        })
        return
      }

      if (msg.type === 'peer-left') {
        setMessages(prev => [...prev, buildTextMessage('system', 'Your partner disconnected')])
        setPhase('peer-disconnected')
        return
      }

      if (msg.type === 'room-expired') {
        setPhase('expired')
        return
      }

      if (msg.type === 'room-closed') {
        setPhase('room-closed')
        return
      }

      if (msg.type === 'room-full') {
        setError('Room is full')
        setPhase('error')
        return
      }

      if (msg.type === 'error') {
        setError(msg.message)
        setPhase('error')
        return
      }

      if (msg.type === 'message') {
        if (!ratchetRef.current) return
        try {
          const payloadBytes = fromBase64Url(msg.payload)
          const iv = payloadBytes.slice(0, 12)
          const ciphertext = payloadBytes.slice(12)
          const { state: newState, plaintext } = await ratchetDecrypt(
            ratchetRef.current,
            msg.header,
            iv,
            ciphertext,
          )
          ratchetRef.current = newState
          const decoded = new TextDecoder().decode(plaintext)
          const parsed: unknown = JSON.parse(decoded)
          const result = DecryptedPayloadSchema.safeParse(parsed)
          if (!result.success) return
          const data = result.data
          if (data.kind === 'text') {
            const id = data.msgId ?? generateMessageId()
            const content = data.content
            const replyToId = data.replyTo
            const peerTs = data.ts
            setMessages(prev => {
              const replyPreview = replyToId
                ? findReplyPreview(prev, replyToId)
                : undefined
              return _insertSorted(prev, {
                ...buildTextMessage('peer', content, peerUsernameRef.current ?? undefined, id, peerTs),
                replyTo: replyToId,
                replyPreview,
                timed: data.timed || undefined,
              })
            })
          } else if (data.kind === 'reaction') {
            const { msgId, emoji, action } = data
            setMessages(prev => applyReaction(prev, msgId, emoji, action, false))
          } else if (data.kind === 'username-set') {
            const nextPeerUsername = data.username.trim().slice(0, 24)
            if (!nextPeerUsername) return
            peerUsernameRef.current = nextPeerUsername
            setPeerUsername(nextPeerUsername)
          } else if (
            data.kind === 'voice-note-meta' ||
            data.kind === 'voice-note-chunk' ||
            data.kind === 'voice-note-complete'
          ) {
            onVoiceNotePayload(data, 'peer')
          } else if (
            data.kind === 'file-meta' ||
            data.kind === 'file-chunk' ||
            data.kind === 'file-complete'
          ) {
            onFilePayload(data, 'peer')
          } else if (data.kind === 'timed-consumed') {
            setMessages(prev => prev.map(msg =>
              msg.id === data.noteId ? { ...msg, timedConsumed: true } : msg
            ))
          } else if (
            data.kind === 'gallery-meta' ||
            data.kind === 'gallery-complete'
          ) {
            onGalleryPayload(data, 'peer')
          } else if (data.kind === 'poll') {
            setMessages(prev => _insertSorted(prev, _buildPollMessage(
              'peer', data.pollId, data.question, data.questionEmoji,
              data.options, data.allowMultiple,
              peerUsernameRef.current ?? undefined, data.ts,
            )))
          } else if (data.kind === 'poll-vote') {
            const previous = peerPollVotesRef.current.get(data.pollId) ?? []
            setMessages(prev => _applyPollVote(prev, data.pollId, data.optionIndices, false, previous))
            peerPollVotesRef.current.set(data.pollId, data.optionIndices)
          } else if (data.kind === 'notefade') {
            const id = data.msgId ?? generateMessageId()
            setMessages(prev => {
              const replyPreview = data.replyTo ? findReplyPreview(prev, data.replyTo) : undefined
              return _insertSorted(prev, {
                ...buildNotefadeMessage('peer', data.url, peerUsernameRef.current ?? undefined, id, data.ts),
                replyTo: data.replyTo,
                replyPreview,
              })
            })
          } else {
            voiceHandlerRef?.current?.(data)
          }
        } catch {
          // Decryption or parse failed — ignore
        }
        return
      }

      if (msg.type === 'typing') {
        if (typingSafetyRef.current) {
          clearTimeout(typingSafetyRef.current)
          typingSafetyRef.current = null
        }
        if (msg.active) {
          setPeerTyping(true)
          typingSafetyRef.current = setTimeout(() => {
            setPeerTyping(false)
          }, TYPING_SAFETY_TIMEOUT)
        } else {
          setPeerTyping(false)
        }
        return
      }
    }

    start()

    return () => {
      cancelled = true
      cleanup()
    }
  }, [roomId, creatorPubKeyB64]) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (text: string, replyTo?: string, timed?: boolean) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const msgId = generateMessageId()
    const ts = Date.now()
    const payloadObj: Record<string, unknown> = { kind: 'text', content: trimmed, msgId, ts }
    if (replyTo) payloadObj.replyTo = replyTo
    if (timed) payloadObj.timed = true

    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState

    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    setMessages(prev => {
      const replyPreview = replyTo ? findReplyPreview(prev, replyTo) : undefined
      return _insertSorted(prev, {
        ...buildTextMessage('self', trimmed, localUsernameRef.current ?? undefined, msgId, ts),
        replyTo,
        replyPreview,
        timed: timed || undefined,
      })
    })
  }, [])

  const sendNotefade = useCallback(async (url: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const msgId = generateMessageId()
    const ts = Date.now()
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'notefade', url, msgId, ts,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    setMessages(prev => _insertSorted(prev, buildNotefadeMessage(
      'self', url, localUsernameRef.current ?? undefined, msgId, ts,
    )))
  }, [])

  const sendReaction = useCallback(async (msgId: string, emoji: string, action: 'add' | 'remove') => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'reaction', msgId, emoji, action }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    // Optimistic local update
    setMessages(prev => applyReaction(prev, msgId, emoji, action, true))
  }, [])

  const removeTimedMessage = useCallback((targetMsgId: string) => {
    setMessages(prev => prev.filter(msg => msg.id !== targetMsgId))
  }, [])

  const sendVoiceSignal = useCallback(async (signal: VoiceSignal) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(JSON.stringify(signal))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const sendVoiceNote = useCallback(async (
    blob: Blob,
    durationMs: number,
    mimeType: string,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0 || bytes.length > VOICE_NOTE_MAX_BYTES) return

    const noteId = generateMessageId()
    const ts = Date.now()
    const chunks = _chunkBytes(bytes, VOICE_NOTE_CHUNK_BYTES)
    const meta: VoiceNoteMeta = {
      kind: 'voice-note-meta',
      noteId,
      mimeType,
      durationMs,
      totalChunks: chunks.length,
      totalBytes: bytes.length,
      timed: timed || undefined,
      ts,
    }
    const messages: VoiceNotePayload[] = [
      meta,
      ...chunks.map((chunk, index): VoiceNoteChunk => ({
        kind: 'voice-note-chunk',
        noteId,
        index,
        data: toBase64Url(chunk),
      })),
      { kind: 'voice-note-complete', noteId },
    ]

    for (const message of messages) {
      const plaintext = new TextEncoder().encode(JSON.stringify(message))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
        ratchetRef.current,
        plaintext,
      )
      ratchetRef.current = newState
      const payload = toBase64Url(concatBytes(iv, ciphertext))
      wsRef.current.send({ type: 'message', header, payload })
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    setMessages(prev => _insertSorted(prev, buildAudioMessage(
      'self',
      objectUrl,
      durationMs,
      localUsernameRef.current ?? undefined,
      noteId,
      timed,
      ts,
    )))
    void computeWaveform(blob).then(w => {
      setMessages(prev => prev.map(m => m.id === noteId ? { ...m, waveform: w } : m))
    })
  }, [trackAudioUrl])

  const sendFile = useCallback(async (
    file: File,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const maxBytes = fileMaxBytes(file.type)
    if (bytes.length === 0 || bytes.length > maxBytes) return

    const fileId = generateMessageId()
    const ts = Date.now()
    const chunks = _chunkBytes(bytes, FILE_CHUNK_BYTES)
    const meta: FileTransferMeta = {
      kind: 'file-meta',
      fileId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: chunks.length,
      totalBytes: bytes.length,
      timed: timed || undefined,
      ts,
    }
    const payloads: FileTransferPayload[] = [
      meta,
      ...chunks.map((chunk, index): FileTransferChunk => ({
        kind: 'file-chunk',
        fileId,
        index,
        data: toBase64Url(chunk),
      })),
      { kind: 'file-complete', fileId },
    ]

    const fileObjectUrl = URL.createObjectURL(file)
    trackFileUrl(fileObjectUrl)
    const msgKind = IMAGE_MIME_TYPES.has(file.type) ? 'image' as const : 'file' as const
    setMessages(prev => _insertSorted(prev, {
      ...buildFileMessage(
        'self', msgKind, fileObjectUrl, file.name,
        file.type || 'application/octet-stream', bytes.length,
        localUsernameRef.current ?? undefined,
        fileId, timed, ts,
      ),
      transferProgress: 0,
    }))

    for (let i = 0; i < payloads.length; i++) {
      const message = payloads[i]
      if (!message) continue
      const plaintext = new TextEncoder().encode(JSON.stringify(message))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
        ratchetRef.current,
        plaintext,
      )
      ratchetRef.current = newState
      const encPayload = toBase64Url(concatBytes(iv, ciphertext))
      wsRef.current.send({ type: 'message', header, payload: encPayload })
      if (message.kind === 'file-chunk') {
        const progress = (i) / (payloads.length - 1)
        setMessages(prev => prev.map(m =>
          m.id === fileId ? { ...m, transferProgress: progress } : m
        ))
      }
      await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
    }

    setMessages(prev => prev.map(m =>
      m.id === fileId ? { ...m, transferProgress: undefined } : m
    ))
  }, [trackFileUrl])

  const sendTimedConsumed = useCallback(async (noteId: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'timed-consumed', noteId }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
  }, [])

  const sendPoll = useCallback(async (
    question: string,
    questionEmoji: string,
    options: Array<{ text: string; emoji: string }>,
    allowMultiple: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const pollId = generateMessageId()
    const ts = Date.now()
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'poll', pollId, question, questionEmoji, options, allowMultiple, ts,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    setMessages(prev => _insertSorted(prev, _buildPollMessage(
      'self', pollId, question, questionEmoji, options, allowMultiple,
      localUsernameRef.current ?? undefined, ts,
    )))
  }, [])

  const sendPollVote = useCallback(async (pollId: string, optionIndices: number[]) => {
    if (!ratchetRef.current || !wsRef.current) return
    const plaintext = new TextEncoder().encode(JSON.stringify({
      kind: 'poll-vote', pollId, optionIndices,
    }))
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState
    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })
    const previous = selfPollVotesRef.current.get(pollId) ?? []
    setMessages(prev => _applyPollVote(prev, pollId, optionIndices, true, previous))
    selfPollVotesRef.current.set(pollId, optionIndices)
  }, [])

  const sendGallery = useCallback(async (
    files: File[],
    caption?: string,
    timed?: boolean,
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const validFiles = files.slice(0, GALLERY_MAX_IMAGES).filter(f =>
      f.size > 0 && f.size <= FILE_MAX_IMAGE_BYTES && IMAGE_MIME_TYPES.has(f.type)
    )
    if (validFiles.length === 0) return

    const galleryId = generateMessageId()
    const ts = Date.now()

    const imageEntries = await Promise.all(validFiles.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const fileId = generateMessageId()
      const chunks = _chunkBytes(bytes, FILE_CHUNK_BYTES)
      const objectUrl = URL.createObjectURL(file)
      trackFileUrl(objectUrl)
      return { file, bytes, fileId, chunks, objectUrl }
    }))

    const galleryMeta: GalleryMeta = {
      kind: 'gallery-meta',
      galleryId,
      caption: caption || undefined,
      timed: timed || undefined,
      ts,
      images: imageEntries.map(e => ({
        fileId: e.fileId,
        fileName: e.file.name,
        mimeType: e.file.type,
        totalChunks: e.chunks.length,
        totalBytes: e.bytes.length,
      })),
    }
    {
      const plaintext = new TextEncoder().encode(JSON.stringify(galleryMeta))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
      ratchetRef.current = newState
      wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
    }

    setMessages(prev => _insertSorted(prev, {
      id: galleryId,
      kind: 'gallery',
      text: caption || undefined,
      sender: 'self',
      displayName: localUsernameRef.current ?? undefined,
      timestamp: ts,
      reactions: [],
      timed: timed || undefined,
      gallery: imageEntries.map(e => ({
        fileId: e.fileId,
        fileUrl: e.objectUrl,
        fileName: e.file.name,
        mimeType: e.file.type,
        fileSize: e.bytes.length,
      })),
    }))

    for (const entry of imageEntries) {
      const meta: FileTransferMeta = {
        kind: 'file-meta',
        fileId: entry.fileId,
        fileName: entry.file.name,
        mimeType: entry.file.type,
        totalChunks: entry.chunks.length,
        totalBytes: entry.bytes.length,
        galleryId,
      }
      const payloads: FileTransferPayload[] = [
        meta,
        ...entry.chunks.map((chunk, index): FileTransferChunk => ({
          kind: 'file-chunk',
          fileId: entry.fileId,
          index,
          data: toBase64Url(chunk),
          galleryId,
        })),
        { kind: 'file-complete', fileId: entry.fileId, galleryId },
      ]

      for (const message of payloads) {
        const plaintext = new TextEncoder().encode(JSON.stringify(message))
        const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
        ratchetRef.current = newState
        wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
        await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
      }
    }

    const galleryComplete: GalleryComplete = { kind: 'gallery-complete', galleryId }
    {
      const plaintext = new TextEncoder().encode(JSON.stringify(galleryComplete))
      const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(ratchetRef.current, plaintext)
      ratchetRef.current = newState
      wsRef.current.send({ type: 'message', header, payload: toBase64Url(concatBytes(iv, ciphertext)) })
    }
  }, [trackFileUrl])

  const sendTyping = useCallback((active: boolean) => {
    wsRef.current?.send({ type: 'typing', active })
  }, [])

  const endChat = useCallback(() => {
    wsRef.current?.cancelReconnect()
    cleanup()
    setPhase('peer-left')
    window.location.hash = ''
  }, [cleanup])

  const endChatForAll = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.cancelReconnect()
      try { wsRef.current.send({ type: 'close-room' }) } catch { /* ignore */ }
    }
    cleanup()
    setPhase('room-closed')
    window.location.hash = ''
  }, [cleanup])

  return {
    phase,
    messages,
    peerTyping,
    inviteUrl: null,
    sendMessage,
    sendNotefade,
    sendReaction,
    removeTimedMessage,
    sendTimedConsumed,
    sendPoll,
    sendPollVote,
    sendGallery,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    sendFile,
    endChat,
    endChatForAll,
    roomSettings: resolvedRoomSettings,
    usernameModeEnabled: resolvedRoomSettings.usernameModeEnabled,
    localUsername,
    peerUsername,
    setLocalUsername: setLocalUsernameAndNotify,
    mediaKeyRaw,
    error,
  }
}
