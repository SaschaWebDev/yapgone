import { useState, useRef, useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { z } from 'zod'
import {
  generateKeyPair,
  exportPublicKey,
  toBase64Url,
  fromBase64Url,
  concatBytes,
  xorSplit,
  ratchetEncrypt,
  ratchetDecrypt,
  deriveMediaKeyRaw,
  senderKeyEncrypt,
  senderKeyDecrypt,
} from '@/crypto'
import {
  initGroupMember,
  establishPairwiseRatchet,
  encryptSenderKeyForPeer,
  receiveSenderKeyFromPeer,
  handleMemberLeft,
  destroyGroupMemberCrypto,
  rekeyGroupMember,
} from '@/crypto/group-key-exchange'
import type { GroupMemberCrypto } from '@/crypto/group-key-exchange'
import { createReconnectingWebSocket } from '@/ws/reconnecting-client'
import type { ReconnectingChatWebSocket } from '@/ws/reconnecting-client'
import type { VoiceSignal } from '@/types'
import { buildWsUrl, buildSplitInviteFragment, storeShard, fetchShard, isSplitInvite, updateRoomConfig } from '@/api'
import { computeWaveform, getOrCreateClientId } from '@/utils'
import type { RoomSettings } from '@/room-settings'
import { DEFAULT_ROOM_SETTINGS, normalizeRoomSettings } from '@/room-settings'
import {
  MAX_MESSAGE_LENGTH,
  VOICE_NOTE_CHUNK_BYTES,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_ASSEMBLY_TIMEOUT_MS,
  FILE_MAX_IMAGE_BYTES,
  FILE_MAX_GENERAL_BYTES,
  FILE_MAX_VIDEO_BYTES,
  FILE_CHUNK_BYTES,
  FILE_SEND_DELAY_MS,
  FILE_ASSEMBLY_TIMEOUT_MS,
  FILE_MAX_CONCURRENT_TRANSFERS,
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  GALLERY_MAX_IMAGES,
  STORAGE_KEYS,
} from '@/constants'
import type { ChatMessage, GalleryImage, PredictionMode } from './chat-helpers'
import {
  generateMessageId,
  buildTextMessage,
  buildAudioMessage,
  buildFileMessage,
  buildNotefadeMessage,
  buildNotefadeChatMessage,
  buildPollMessage,
  buildPredictionMessage,
  applyReaction,
  findReplyPreview,
  applyPollVote,
  applyPredictionVote,
  applyPredictionOutcome,
  applyPredictionDelete,
  insertSorted,
  chunkBytes,
  concatChunks,
} from './chat-helpers'

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

type VoiceHandlerRef = RefObject<((signal: VoiceSignal, senderId: string) => void) | null>
type GroupVoiceHandlerRef = RefObject<((signal: { kind: string; key?: string }, senderId: string) => void) | null>

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
  z.object({ kind: z.literal('notefade-chat-revealed'), noteId: z.string().min(1) }),
  z.object({ kind: z.literal('notefade-chat-destroyed'), noteId: z.string().min(1) }),
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
    kind: z.literal('prediction'),
    predictionId: z.string().min(1).max(32),
    title: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(200)).min(2).max(10),
    durationMs: z.number().int().positive(),
    ts: z.number(),
    mode: z.enum(['yesno', 'complex']),
  }),
  z.object({
    kind: z.literal('prediction-vote'),
    predictionId: z.string().min(1).max(32),
    optionIndex: z.number().int().nonnegative().max(9),
  }),
  z.object({
    kind: z.literal('prediction-outcome'),
    predictionId: z.string().min(1).max(32),
    winnerIndex: z.number().int().nonnegative().max(9),
  }),
  z.object({
    kind: z.literal('prediction-delete'),
    predictionId: z.string().min(1).max(32),
  }),
  z.object({
    kind: z.literal('notefade'),
    url: z.string().url(),
    msgId: z.string().min(1).max(32).optional(),
    replyTo: z.string().min(1).max(32).optional(),
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('notefade-chat'),
    url: z.string().url(),
    msgId: z.string().min(1).max(32).optional(),
    replyTo: z.string().min(1).max(32).optional(),
    ts: z.number().optional(),
  }),
  z.object({
    kind: z.literal('sender-key-distribution'),
    senderId: z.string().min(1),
    verifyingKey: z.string().min(1),
    chainKey: z.string().min(1),
  }),
  z.object({ kind: z.literal('rekey-request') }),
  z.object({ kind: z.literal('group-voice-join') }),
  z.object({ kind: z.literal('group-voice-leave') }),
  z.object({ kind: z.literal('group-voice-key'), key: z.string().min(1) }),
])

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

function fileMaxBytes(mimeType: string): number {
  if (IMAGE_MIME_TYPES.has(mimeType)) return FILE_MAX_IMAGE_BYTES
  if (VIDEO_MIME_TYPES.has(mimeType)) return FILE_MAX_VIDEO_BYTES
  return FILE_MAX_GENERAL_BYTES
}

function detectFileKind(mimeType: string): 'image' | 'video' | 'file' {
  if (IMAGE_MIME_TYPES.has(mimeType)) return 'image'
  if (VIDEO_MIME_TYPES.has(mimeType)) return 'video'
  return 'file'
}

const TYPING_SAFETY_TIMEOUT = 30_000

/**
 * Unified chat hook supporting both 2-party and N-party rooms.
 * For 2-party rooms, uses pairwise Double Ratchet directly for stronger forward secrecy.
 * For group rooms (3+), uses Sender Key encryption with pairwise ratchets for key distribution.
 */
export function useGroupChat(
  roomId: string,
  role: 'creator' | 'joiner',
  creatorPubKeyOrShare?: string,
  voiceHandlerRef?: VoiceHandlerRef,
  groupVoiceHandlerRef?: GroupVoiceHandlerRef,
  initialRoomSettings?: RoomSettings | null,
) {
  const [phase, setPhase] = useState<ChatPhase>(role === 'creator' ? 'creating' : 'connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roomSettings, setRoomSettings] = useState<RoomSettings>(() =>
    normalizeRoomSettings(initialRoomSettings ?? DEFAULT_ROOM_SETTINGS),
  )
  const [localUsername, setLocalUsername] = useState<string | null>(null)
  const [peerUsernames, setPeerUsernames] = useState<Map<string, string>>(new Map())
  const [mediaKeyRaw, setMediaKeyRaw] = useState<Uint8Array | null>(null)
  const [participantCount, setParticipantCount] = useState(1)
  const [myClientId, setMyClientId] = useState<string | null>(null)
  const [myPubKeyRaw, setMyPubKeyRaw] = useState<Uint8Array | null>(null)
  const [peerPubKeysMap, setPeerPubKeysMap] = useState<Map<string, Uint8Array>>(new Map())

  const myClientIdRef = useRef<string | null>(null)
  const wsRef = useRef<ReconnectingChatWebSocket | null>(null)
  const groupCryptoRef = useRef<GroupMemberCrypto | null>(null)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)
  const urlShareRef = useRef<string | null>(null)
  const roomSettingsRef = useRef<RoomSettings>(normalizeRoomSettings(initialRoomSettings ?? DEFAULT_ROOM_SETTINGS))
  const localUsernameRef = useRef<string | null>(null)
  const peerUsernamesRef = useRef<Map<string, string>>(new Map())
  const cleanedUpRef = useRef(false)
  const configTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const voiceNoteAssembliesRef = useRef<Map<string, VoiceNoteAssembly>>(new Map())
  const localAudioUrlsRef = useRef<Set<string>>(new Set())
  const fileAssembliesRef = useRef<Map<string, FileAssembly>>(new Map())
  const localFileUrlsRef = useRef<Set<string>>(new Set())
  const galleryAssembliesRef = useRef<Map<string, GalleryAssembly>>(new Map())
  const peerPollVotesRef = useRef<Map<string, number[]>>(new Map())
  const selfPollVotesRef = useRef<Map<string, number[]>>(new Map())
  const selfPredictionVotesRef = useRef<Map<string, number>>(new Map())
  const peerPredictionVotesRef = useRef<Map<string, number>>(new Map())
  // Track which peers we're still doing key exchange with
  const pendingKeyExchangeRef = useRef<Set<string>>(new Set())
  // For 2-party mode: track the single peer's ratchet for direct use
  const isPairwiseModeRef = useRef(true)
  const pairwisePeerIdRef = useRef<string | null>(null)

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
  }, [])

  const trackFileUrl = useCallback((url: string) => {
    localFileUrlsRef.current.add(url)
  }, [])

  const getPeerDisplayName = useCallback((peerId: string): string | undefined => {
    return peerUsernamesRef.current.get(peerId) ?? undefined
  }, [])

  // ─── Voice note / file / gallery receive handlers ───

  const cleanupVoiceNoteAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [noteId, assembly] of voiceNoteAssembliesRef.current) {
      if (now - assembly.createdAt > VOICE_NOTE_ASSEMBLY_TIMEOUT_MS) {
        voiceNoteAssembliesRef.current.delete(noteId)
      }
    }
  }, [])

  const onVoiceNotePayload = useCallback((
    payload: { kind: 'voice-note-meta'; noteId: string; mimeType: string; durationMs: number; totalChunks: number; totalBytes: number; timed?: boolean; ts?: number }
      | { kind: 'voice-note-chunk'; noteId: string; index: number; data: string }
      | { kind: 'voice-note-complete'; noteId: string },
    senderId: string,
  ) => {
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

    // voice-note-complete
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
    const bytes = concatChunks(orderedChunks)
    const arrayBuffer = new ArrayBuffer(bytes.length)
    new Uint8Array(arrayBuffer).set(bytes)
    const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    const rcvNoteId = payload.noteId
    const peerName = getPeerDisplayName(senderId)
    setMessages(prev => insertSorted(prev, {
      ...buildAudioMessage(
        'peer', objectUrl, assembly.durationMs, peerName,
        rcvNoteId, assembly.timed, assembly.ts,
      ),
      senderId,
    }))
    void computeWaveform(blob).then(w => {
      setMessages(prev => prev.map(m => m.id === rcvNoteId ? { ...m, waveform: w } : m))
    })
    voiceNoteAssembliesRef.current.delete(payload.noteId)
  }, [cleanupVoiceNoteAssemblies, trackAudioUrl, getPeerDisplayName])

  const cleanupFileAssemblies = useCallback(() => {
    const now = Date.now()
    for (const [fileId, assembly] of fileAssembliesRef.current) {
      if (now - assembly.createdAt > FILE_ASSEMBLY_TIMEOUT_MS) {
        fileAssembliesRef.current.delete(fileId)
        setMessages(prev => prev.filter(m => m.id !== fileId))
      }
    }
  }, [])

  const onFilePayload = useCallback((
    payload: { kind: 'file-meta'; fileId: string; fileName: string; mimeType: string; totalChunks: number; totalBytes: number; timed?: boolean; ts?: number; galleryId?: string }
      | { kind: 'file-chunk'; fileId: string; index: number; data: string; galleryId?: string }
      | { kind: 'file-complete'; fileId: string; galleryId?: string },
    senderId: string,
  ) => {
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
      const fileBytes = concatChunks(orderedChunks)
      const arrayBuffer = new ArrayBuffer(fileBytes.length)
      new Uint8Array(arrayBuffer).set(fileBytes)
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
      const msgKind = detectFileKind(payload.mimeType)
      const peerName = getPeerDisplayName(senderId)
      setMessages(prev => insertSorted(prev, {
        ...buildFileMessage(
          'peer', msgKind, '', payload.fileName,
          payload.mimeType, payload.totalBytes,
          peerName, payload.fileId, payload.timed, payload.ts,
        ),
        senderId,
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

    // file-complete (standalone)
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
    const fileBytes = concatChunks(orderedChunks)
    const arrayBuffer = new ArrayBuffer(fileBytes.length)
    new Uint8Array(arrayBuffer).set(fileBytes)
    const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(blob)
    trackFileUrl(objectUrl)
    const msgKind = detectFileKind(assembly.mimeType)
    const peerName = getPeerDisplayName(senderId)
    setMessages(prev => prev.map(m =>
      m.id === payload.fileId ? {
        ...buildFileMessage(
          'peer', msgKind, objectUrl, assembly.fileName,
          assembly.mimeType, assembly.totalBytes,
          peerName, payload.fileId, assembly.timed, assembly.ts,
        ),
        senderId,
        reactions: m.reactions,
        transferProgress: undefined,
      } : m
    ))
    if (assembly.mimeType.startsWith('audio/')) {
      void computeWaveform(blob).then(w => {
        setMessages(prev => prev.map(m => m.id === payload.fileId ? { ...m, waveform: w } : m))
      })
    }
    fileAssembliesRef.current.delete(payload.fileId)
  }, [cleanupFileAssemblies, trackFileUrl, getPeerDisplayName])

  const onGalleryPayload = useCallback((
    data: { kind: 'gallery-meta'; galleryId: string; caption?: string; timed?: boolean; ts?: number; images: Array<{ fileId: string; fileName: string; mimeType: string; totalChunks: number; totalBytes: number }> }
      | { kind: 'gallery-complete'; galleryId: string },
    senderId: string,
  ) => {
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
      const peerName = getPeerDisplayName(senderId)
      setMessages(prev => insertSorted(prev, {
        id: data.galleryId,
        kind: 'gallery',
        text: data.caption,
        sender: 'peer',
        senderId,
        displayName: peerName,
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
  }, [getPeerDisplayName])

  /**
   * Encrypt and send a message.
   * In pairwise mode (2-party): uses Double Ratchet directly.
   * In group mode (3+): uses Sender Key encryption + broadcasts.
   */
  const encryptAndSend = useCallback(async (payloadObj: Record<string, unknown>) => {
    const gc = groupCryptoRef.current
    const ws = wsRef.current
    if (!gc || !ws) return

    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj))

    if (isPairwiseModeRef.current && pairwisePeerIdRef.current) {
      // Pairwise mode — use Double Ratchet
      const peerId = pairwisePeerIdRef.current
      const ratchet = gc.pairwiseRatchets.get(peerId)
      if (!ratchet) return

      const { state: newRatchet, header, iv, ciphertext } = await ratchetEncrypt(ratchet, plaintext)
      const newPairwise = new Map(gc.pairwiseRatchets)
      newPairwise.set(peerId, newRatchet)
      groupCryptoRef.current = { ...gc, pairwiseRatchets: newPairwise }

      const payload = toBase64Url(concatBytes(iv, ciphertext))
      ws.send({ type: 'message', header, payload })
    } else {
      // Group mode — use Sender Key encryption
      const { state: newSenderKey, messageNumber, iv, ciphertext, signature } =
        await senderKeyEncrypt(gc.mySenderKey, plaintext)
      groupCryptoRef.current = { ...gc, mySenderKey: newSenderKey }

      // Pack as: senderId | messageNumber(4B) | iv(12B) | signature(len2B + data) | ciphertext
      const senderIdBytes = new TextEncoder().encode(gc.myId)
      const msgNumBuf = new Uint8Array(4)
      msgNumBuf[0] = (messageNumber >>> 24) & 0xff
      msgNumBuf[1] = (messageNumber >>> 16) & 0xff
      msgNumBuf[2] = (messageNumber >>> 8) & 0xff
      msgNumBuf[3] = messageNumber & 0xff

      const sigLen = new Uint8Array(2)
      sigLen[0] = (signature.length >>> 8) & 0xff
      sigLen[1] = signature.length & 0xff

      const packed = concatBytes(
        new Uint8Array([senderIdBytes.length]),
        senderIdBytes,
        msgNumBuf,
        iv,
        sigLen,
        signature,
        ciphertext,
      )
      const payload = toBase64Url(packed)

      // Broadcast header uses a fixed placeholder since sender key doesn't need DH headers
      ws.send({
        type: 'message',
        header: { pubkey: toBase64Url(gc.myPubKeyRaw), n: messageNumber, pn: 0 },
        payload,
      })
    }
  }, [])

  /**
   * Decrypt an incoming broadcast message.
   */
  const decryptBroadcast = useCallback(async (
    header: { pubkey: string; n: number; pn: number },
    payload: string,
  ): Promise<{ senderId: string; plaintext: Uint8Array } | null> => {
    const gc = groupCryptoRef.current
    if (!gc) return null

    if (isPairwiseModeRef.current && pairwisePeerIdRef.current) {
      // Pairwise mode — use Double Ratchet
      const peerId = pairwisePeerIdRef.current
      const ratchet = gc.pairwiseRatchets.get(peerId)
      if (!ratchet) return null

      const payloadBytes = fromBase64Url(payload)
      const iv = payloadBytes.slice(0, 12)
      const ciphertext = payloadBytes.slice(12)
      const { state: newRatchet, plaintext } = await ratchetDecrypt(ratchet, header, iv, ciphertext)

      const newPairwise = new Map(gc.pairwiseRatchets)
      newPairwise.set(peerId, newRatchet)
      groupCryptoRef.current = { ...gc, pairwiseRatchets: newPairwise }

      return { senderId: peerId, plaintext }
    } else {
      // Group mode — unpack sender key message
      const packed = fromBase64Url(payload)
      let offset = 0

      const senderIdLen = packed[offset] ?? 0
      offset += 1
      const senderIdBytes = packed.slice(offset, offset + senderIdLen)
      offset += senderIdLen
      const senderId = new TextDecoder().decode(senderIdBytes)

      const messageNumber = (
        ((packed[offset] ?? 0) << 24) |
        ((packed[offset + 1] ?? 0) << 16) |
        ((packed[offset + 2] ?? 0) << 8) |
        (packed[offset + 3] ?? 0)
      ) >>> 0
      offset += 4

      const iv = packed.slice(offset, offset + 12)
      offset += 12

      const sigLen = ((packed[offset] ?? 0) << 8) | (packed[offset + 1] ?? 0)
      offset += 2
      const signature = packed.slice(offset, offset + sigLen)
      offset += sigLen

      const ciphertext = packed.slice(offset)

      const receivedKey = gc.peerSenderKeys.get(senderId)
      if (!receivedKey) return null

      const { received: updatedKey, plaintext } = await senderKeyDecrypt(
        receivedKey, messageNumber, iv, ciphertext, signature,
      )

      const newPeerSenderKeys = new Map(gc.peerSenderKeys)
      newPeerSenderKeys.set(senderId, updatedKey)
      groupCryptoRef.current = { ...gc, peerSenderKeys: newPeerSenderKeys }

      return { senderId, plaintext }
    }
  }, [])

  const setLocalUsernameAndNotify = useCallback(async (username: string) => {
    const trimmed = username.trim().slice(0, 24)
    if (!trimmed) return
    localUsernameRef.current = trimmed
    setLocalUsername(trimmed)
    await encryptAndSend({ kind: 'username-set', username: trimmed })
  }, [encryptAndSend])

  const refreshInviteUrl = useCallback((nextSettings: RoomSettings) => {
    const urlShareB64 = urlShareRef.current
    if (!urlShareB64) return
    const fragment = buildSplitInviteFragment(roomId, urlShareB64, nextSettings)
    const url = `${window.location.origin}${window.location.pathname}#${fragment}`
    setInviteUrl(url)
    window.location.hash = fragment
  }, [roomId])

  const updateRoomSettings = useCallback((next: RoomSettings) => {
    const normalized = normalizeRoomSettings(next)
    const prevMax = roomSettingsRef.current.maxParticipants
    roomSettingsRef.current = normalized
    setRoomSettings(normalized)
    if (role === 'creator') {
      refreshInviteUrl(normalized)
      if (normalized.maxParticipants !== prevMax) {
        if (configTimerRef.current) clearTimeout(configTimerRef.current)
        configTimerRef.current = setTimeout(() => {
          void updateRoomConfig(roomId, normalized.maxParticipants)
        }, 300)
      }
    }
  }, [refreshInviteUrl, role, roomId])

  const cleanup = useCallback((skipLeave = false) => {
    if (cleanedUpRef.current) return
    cleanedUpRef.current = true
    if (configTimerRef.current) {
      clearTimeout(configTimerRef.current)
      configTimerRef.current = null
    }
    for (const timer of typingTimersRef.current.values()) {
      clearTimeout(timer)
    }
    typingTimersRef.current.clear()
    if (groupCryptoRef.current) {
      destroyGroupMemberCrypto(groupCryptoRef.current)
      groupCryptoRef.current = null
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
      if (!skipLeave) {
        try { ws.send({ type: 'leave' }) } catch { /* ignore */ }
      }
      setTimeout(() => ws.close(), 100)
    }
  }, [])

  // ─── Main effect ───
  useEffect(() => {
    let cancelled = false
    cleanedUpRef.current = false

    async function handlePeerJoined(peerId: string, clientCount: number) {
      setParticipantCount(clientCount)
      const gc = groupCryptoRef.current
      const ws = wsRef.current
      if (!gc || !ws) return

      // Send our public key to the new peer via direct message
      const pubKeyB64 = toBase64Url(gc.myPubKeyRaw)
      ws.send({
        type: 'direct' as const,
        targetId: peerId,
        payload: JSON.stringify({ type: 'pubkey', key: pubKeyB64, senderId: gc.myId }),
      })
      pendingKeyExchangeRef.current.add(peerId)
    }

    async function handlePeerLeft(peerId: string, clientCount: number) {
      setParticipantCount(clientCount)
      const gc = groupCryptoRef.current
      if (!gc) return

      // Remove peer and rekey
      groupCryptoRef.current = await handleMemberLeft(gc, peerId)
      setPeerPubKeysMap(new Map(groupCryptoRef.current.peerPubKeys))

      // Update peer usernames
      const newUsernames = new Map(peerUsernamesRef.current)
      newUsernames.delete(peerId)
      peerUsernamesRef.current = newUsernames
      setPeerUsernames(new Map(newUsernames))

      // Determine mode
      const peerCount = groupCryptoRef.current.pairwiseRatchets.size
      isPairwiseModeRef.current = peerCount <= 1
      if (peerCount === 1) {
        const [id] = groupCryptoRef.current.pairwiseRatchets.keys()
        pairwisePeerIdRef.current = id ?? null
      } else if (peerCount === 0) {
        pairwisePeerIdRef.current = null
      }

      // Distribute new sender key to remaining peers
      if (peerCount > 1) {
        await distributeSenderKeyToAll()
      }

      if (clientCount === 1) {
        setMessages(prev => [...prev, buildTextMessage('system', 'Everyone else has left')])
        setPhase('peer-left')
      } else {
        const name = getPeerDisplayName(peerId) ?? 'A participant'
        setMessages(prev => [...prev, buildTextMessage('system', `${name} left`)])
      }
    }

    const DirectPubkeySchema = z.object({
      type: z.literal('pubkey'),
      key: z.string(),
      senderId: z.string().optional(),
    })
    const DirectSenderKeySchema = z.object({
      type: z.literal('sender-key'),
      header: z.object({ pubkey: z.string(), n: z.number(), pn: z.number() }),
      payload: z.string(),
    })

    async function handleDirectMessage(senderId: string, rawPayload: string) {
      const gc = groupCryptoRef.current
      const ws = wsRef.current
      if (!gc || !ws) return

      const parsed: unknown = JSON.parse(rawPayload)

      // Pubkey exchange from a peer
      const pubkeyResult = DirectPubkeySchema.safeParse(parsed)
      if (pubkeyResult.success) {
        const peerPubKeyRaw = fromBase64Url(pubkeyResult.data.key)

        // Establish pairwise ratchet
        const { state: updated, rootKey } = await establishPairwiseRatchet(gc, senderId, peerPubKeyRaw)
        groupCryptoRef.current = updated
        setPeerPubKeysMap(new Map(updated.peerPubKeys))

        // Derive media key from shared ECDH root key (same for both peers)
        setMediaKeyRaw(await deriveMediaKeyRaw(rootKey))

        // Send our sender key to this peer
        const result = await encryptSenderKeyForPeer(groupCryptoRef.current, senderId)
        if (result) {
          groupCryptoRef.current = result.state
          ws.send({
            type: 'direct',
            targetId: senderId,
            payload: JSON.stringify({
              type: 'sender-key',
              header: result.header,
              payload: result.payload,
            }),
          })
        }

        // Also send our pubkey back if they don't have ours yet
        if (!pendingKeyExchangeRef.current.has(senderId)) {
          ws.send({
            type: 'direct',
            targetId: senderId,
            payload: JSON.stringify({
              type: 'pubkey',
              key: toBase64Url(gc.myPubKeyRaw),
              senderId: gc.myId,
            }),
          })
        }
        pendingKeyExchangeRef.current.delete(senderId)

        // Check if this is the first peer (2-party mode)
        const peerCount = groupCryptoRef.current.pairwiseRatchets.size
        isPairwiseModeRef.current = peerCount <= 1
        if (peerCount === 1) {
          pairwisePeerIdRef.current = senderId
        }

        // Set ready if we were in key-exchange
        setPhase(prev => prev === 'key-exchange' || prev === 'waiting' ? 'ready' : prev)
        return
      }

      // Sender key distribution from a peer
      const senderKeyResult = DirectSenderKeySchema.safeParse(parsed)
      if (senderKeyResult.success) {
        const { header, payload } = senderKeyResult.data
        const result = await receiveSenderKeyFromPeer(gc, senderId, header, payload)
        if (result) {
          groupCryptoRef.current = result
        }

        // Check mode
        const currentGc = groupCryptoRef.current
        if (!currentGc) return
        const peerCount = currentGc.pairwiseRatchets.size
        if (peerCount > 1) {
          isPairwiseModeRef.current = false
          pairwisePeerIdRef.current = null
        }

        setPhase(prev => prev === 'key-exchange' || prev === 'waiting' ? 'ready' : prev)
        return
      }

      // Group voice key delivery (pairwise-encrypted)
      const DirectGroupVoiceKeySchema = z.object({
        type: z.literal('group-voice-key-delivery'),
        header: z.object({ pubkey: z.string(), n: z.number(), pn: z.number() }),
        payload: z.string(),
      })
      const voiceKeyResult = DirectGroupVoiceKeySchema.safeParse(parsed)
      if (voiceKeyResult.success) {
        const { header, payload: encPayload } = voiceKeyResult.data
        const ratchet = gc.pairwiseRatchets.get(senderId)
        if (!ratchet) return
        try {
          const encBytes = fromBase64Url(encPayload)
          const iv = encBytes.slice(0, 12)
          const ciphertext = encBytes.slice(12)
          const { state: newRatchet, plaintext } = await ratchetDecrypt(ratchet, header, iv, ciphertext)
          const newPairwise = new Map(gc.pairwiseRatchets)
          newPairwise.set(senderId, newRatchet)
          groupCryptoRef.current = { ...gc, pairwiseRatchets: newPairwise }
          const decrypted = JSON.parse(new TextDecoder().decode(plaintext))
          groupVoiceHandlerRef?.current?.({ kind: 'group-voice-key', key: decrypted.key }, senderId)
        } catch { /* invalid voice key — ignore */ }
        return
      }
    }

    async function distributeSenderKeyToAll() {
      const gc = groupCryptoRef.current
      const ws = wsRef.current
      if (!gc || !ws) return

      for (const peerId of gc.pairwiseRatchets.keys()) {
        if (!groupCryptoRef.current) break
        const result = await encryptSenderKeyForPeer(groupCryptoRef.current, peerId)
        if (result) {
          groupCryptoRef.current = result.state
          ws.send({
            type: 'direct',
            targetId: peerId,
            payload: JSON.stringify({
              type: 'sender-key',
              header: result.header,
              payload: result.payload,
            }),
          })
        }
      }
    }

    async function handleBroadcastMessage(
      header: { pubkey: string; n: number; pn: number },
      payload: string,
    ) {
      try {
        const result = await decryptBroadcast(header, payload)
        if (!result) return

        const { senderId, plaintext } = result
        const decoded = new TextDecoder().decode(plaintext)
        const parsed: unknown = JSON.parse(decoded)
        const validated = DecryptedPayloadSchema.safeParse(parsed)
        if (!validated.success) return
        const data = validated.data

        const peerName = getPeerDisplayName(senderId)

        if (data.kind === 'text') {
          const id = data.msgId ?? generateMessageId()
          setMessages(prev => {
            const replyPreview = data.replyTo ? findReplyPreview(prev, data.replyTo) : undefined
            return insertSorted(prev, {
              ...buildTextMessage('peer', data.content, peerName, id, data.ts),
              senderId,
              replyTo: data.replyTo,
              replyPreview,
              timed: data.timed || undefined,
            })
          })
        } else if (data.kind === 'reaction') {
          setMessages(prev => applyReaction(prev, data.msgId, data.emoji, data.action, false, senderId))
        } else if (data.kind === 'username-set') {
          const nextUsername = data.username.trim().slice(0, 24)
          if (!nextUsername) return
          const newUsernames = new Map(peerUsernamesRef.current)
          newUsernames.set(senderId, nextUsername)
          peerUsernamesRef.current = newUsernames
          setPeerUsernames(new Map(newUsernames))
        } else if (data.kind === 'timed-consumed') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.noteId ? { ...msg, timedConsumed: true } : msg
          ))
        } else if (data.kind === 'notefade-chat-revealed') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.noteId ? { ...msg, notefadeRevealed: true } : msg
          ))
        } else if (data.kind === 'notefade-chat-destroyed') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.noteId ? { ...msg, notefadeDestroyed: true } : msg
          ))
        } else if (data.kind === 'poll') {
          setMessages(prev => insertSorted(prev, {
            ...buildPollMessage(
              'peer', data.pollId, data.question, data.questionEmoji,
              data.options, data.allowMultiple, peerName, data.ts,
            ),
            senderId,
          }))
        } else if (data.kind === 'poll-vote') {
          const previous = peerPollVotesRef.current.get(data.pollId) ?? []
          setMessages(prev => applyPollVote(prev, data.pollId, data.optionIndices, false, previous))
          peerPollVotesRef.current.set(data.pollId, data.optionIndices)
        } else if (data.kind === 'prediction') {
          setMessages(prev => insertSorted(prev, buildPredictionMessage(
            'peer', data.predictionId, data.title, data.options,
            data.durationMs, data.mode, peerName, data.ts, senderId,
          )))
        } else if (data.kind === 'prediction-vote') {
          const previous = peerPredictionVotesRef.current.get(data.predictionId)
          setMessages(prev => applyPredictionVote(prev, data.predictionId, data.optionIndex, false, previous))
          peerPredictionVotesRef.current.set(data.predictionId, data.optionIndex)
        } else if (data.kind === 'prediction-outcome') {
          setMessages(prev => applyPredictionOutcome(prev, data.predictionId, data.winnerIndex))
        } else if (data.kind === 'prediction-delete') {
          setMessages(prev => applyPredictionDelete(prev, data.predictionId))
        } else if (data.kind === 'notefade') {
          const id = data.msgId ?? generateMessageId()
          setMessages(prev => {
            const replyPreview = data.replyTo ? findReplyPreview(prev, data.replyTo) : undefined
            return insertSorted(prev, {
              ...buildNotefadeMessage('peer', data.url, peerName, id, data.ts),
              senderId,
              replyTo: data.replyTo,
              replyPreview,
            })
          })
        } else if (data.kind === 'notefade-chat') {
          const id = data.msgId ?? generateMessageId()
          setMessages(prev => {
            const replyPreview = data.replyTo ? findReplyPreview(prev, data.replyTo) : undefined
            return insertSorted(prev, {
              ...buildNotefadeChatMessage('peer', data.url, peerName, id, data.ts),
              senderId,
              replyTo: data.replyTo,
              replyPreview,
            })
          })
        } else if (data.kind === 'rekey-request') {
          // A peer is requesting everyone to rekey
          const gc = groupCryptoRef.current
          if (gc) {
            groupCryptoRef.current = await rekeyGroupMember(gc)
            await distributeSenderKeyToAll()
          }
        } else if (
          data.kind === 'voice-request' || data.kind === 'voice-accept' ||
          data.kind === 'voice-decline' || data.kind === 'voice-end' ||
          data.kind === 'sdp-offer' || data.kind === 'sdp-answer' ||
          data.kind === 'ice-candidate' || data.kind === 'screen-share-start' ||
          data.kind === 'screen-share-stop' || data.kind === 'e2ee-toggle' ||
          data.kind === 'e2ee-downgrade-request' || data.kind === 'e2ee-downgrade-accept' ||
          data.kind === 'e2ee-downgrade-decline'
        ) {
          voiceHandlerRef?.current?.(data, senderId)
        } else if (
          data.kind === 'group-voice-join' ||
          data.kind === 'group-voice-leave' ||
          data.kind === 'group-voice-key'
        ) {
          groupVoiceHandlerRef?.current?.(data, senderId)
        }
        if (
          data.kind === 'voice-note-meta' ||
          data.kind === 'voice-note-chunk' ||
          data.kind === 'voice-note-complete'
        ) {
          onVoiceNotePayload(data, senderId)
        } else if (
          data.kind === 'file-meta' ||
          data.kind === 'file-chunk' ||
          data.kind === 'file-complete'
        ) {
          onFilePayload(data, senderId)
        } else if (
          data.kind === 'gallery-meta' ||
          data.kind === 'gallery-complete'
        ) {
          onGalleryPayload(data, senderId)
        }
      } catch {
        // Decryption or parse failed — ignore
      }
    }

    async function start() {
      try {
        const kp = await generateKeyPair()
        if (cancelled) return
        keyPairRef.current = kp

        if (role === 'creator') {
          // Creator: XOR-split pubkey and store shard
          const pubKeyRaw = await exportPublicKey(kp.publicKey)
          const { share1: urlShare, share2: serverShard } = xorSplit(pubKeyRaw)
          const urlShareB64 = toBase64Url(urlShare)
          const serverShardB64 = toBase64Url(serverShard)
          urlShareRef.current = urlShareB64

          await storeShard(roomId, serverShardB64)

          const fragment = buildSplitInviteFragment(roomId, urlShareB64, roomSettingsRef.current)
          const url = `${window.location.origin}${window.location.pathname}#${fragment}`
          setInviteUrl(url)
          window.location.hash = fragment

          localStorage.setItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`, '1')
          setPhase('waiting')
        } else {
          setPhase('connecting')
        }

        // Connect WebSocket
        const ws = createReconnectingWebSocket()
        wsRef.current = ws

        ws.onOpen = async () => {
          if (cancelled) return
          // Wait for peer-list before doing key exchange
        }

        ws.onMessage = async (msg) => {
          if (cancelled) return

          // Handle peer-list (sent on connect)
          if (msg.type === 'peer-list') {
            const { clientIds, yourId } = msg

            // Resume detection: if we already hold this clientId AND have
            // initialized group crypto, this is a reconnect. Reuse the
            // existing state instead of wiping ratchets and forcing a new
            // key exchange — peers haven't reset, so re-init would desync.
            if (
              myClientIdRef.current === yourId &&
              groupCryptoRef.current !== null
            ) {
              setParticipantCount(clientIds.length + 1)
              return
            }

            setMyClientId(yourId)
            myClientIdRef.current = yourId

            // Initialize group crypto
            const gc = await initGroupMember(yourId, kp)
            groupCryptoRef.current = gc
            setMyPubKeyRaw(gc.myPubKeyRaw)
            setParticipantCount(clientIds.length + 1)

            // If joiner, resolve creator pubkey and do ECDH with first peer
            if (role === 'joiner' && creatorPubKeyOrShare) {
              // If split invite, fetch server shard to trigger KV deletion
              if (isSplitInvite(creatorPubKeyOrShare)) {
                void fetchShard(roomId).catch(() => {
                  // Shard may already be expired/deleted — not fatal for group chat
                })
              }

              // Joiners send their pubkey to all existing peers
              for (const peerId of clientIds) {
                ws.send({
                  type: 'direct',
                  targetId: peerId,
                  payload: JSON.stringify({
                    type: 'pubkey',
                    key: toBase64Url(gc.myPubKeyRaw),
                    senderId: yourId,
                  }),
                })
                pendingKeyExchangeRef.current.add(peerId)
              }
              setPhase(clientIds.length > 0 ? 'key-exchange' : 'waiting')
            } else if (role === 'creator') {
              if (clientIds.length > 0) {
                // The creator finds existing peers in the roster. This
                // happens after a fresh mount (e.g., iOS reloaded the tab
                // while a joiner was already connected). The creator's
                // server-side reconnect was treated as a resume, so peers
                // were not notified via peer-joined and won't proactively
                // send their pubkey. Push our pubkey to all of them now to
                // bootstrap the key exchange — handleDirectMessage on the
                // peer side will send their pubkey back.
                for (const peerId of clientIds) {
                  ws.send({
                    type: 'direct',
                    targetId: peerId,
                    payload: JSON.stringify({
                      type: 'pubkey',
                      key: toBase64Url(gc.myPubKeyRaw),
                      senderId: yourId,
                    }),
                  })
                  pendingKeyExchangeRef.current.add(peerId)
                }
                setPhase('key-exchange')
              }
            }

            return
          }

          if (msg.type === 'peer-joined') {
            await handlePeerJoined(msg.clientId, msg.clientCount)
            return
          }

          if (msg.type === 'peer-left') {
            await handlePeerLeft(msg.clientId, msg.clientCount)
            return
          }

          if (msg.type === 'room-expired') {
            setPhase('expired')
            return
          }

          if (msg.type === 'room-full') {
            wsRef.current?.cancelReconnect()
            setError('Room is full')
            setPhase('error')
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

          // Direct messages (pairwise key exchange)
          // The server attaches senderId and forwards the payload for 'direct' type
          if ('senderId' in msg && 'payload' in msg) {
            const raw: unknown = msg
            const directParse = z.object({ senderId: z.string(), payload: z.string() }).safeParse(raw)
            if (directParse.success) {
              await handleDirectMessage(directParse.data.senderId, directParse.data.payload)
            }
            return
          }

          // Broadcast encrypted messages
          if (msg.type === 'message') {
            await handleBroadcastMessage(msg.header, msg.payload)
            return
          }

          // Typing indicators
          if (msg.type === 'typing') {
            // In group mode, we can't easily attribute typing to a specific peer
            // without the server forwarding senderId. For now, just show generic typing.
            if (msg.active) {
              setPeerTyping(true)
              // Auto-clear after safety timeout
              const timer = setTimeout(() => setPeerTyping(false), TYPING_SAFETY_TIMEOUT)
              typingTimersRef.current.set('typing', timer)
            } else {
              setPeerTyping(false)
              const timer = typingTimersRef.current.get('typing')
              if (timer) {
                clearTimeout(timer)
                typingTimersRef.current.delete('typing')
              }
            }
          }
        }

        ws.onClose = (_code, reason) => {
          if (cancelled) return
          if (reason === 'Room expired') setPhase('expired')
        }

        ws.onError = () => {
          if (cancelled) return
          // Native WebSocket fires onerror immediately followed by onclose,
          // and the reconnecting wrapper handles the close by triggering a
          // retry cycle. Setting phase='error' here would short-circuit the
          // recovery and lock the user into an error state on a transient
          // blip (e.g., the brief network instability iOS Safari produces
          // right after a tab returns from background). Defer to the close
          // handler / reconnect cycle / onReconnectFailed instead.
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

        ws.connect(buildWsUrl(roomId, getOrCreateClientId(roomId)))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown error')
        setPhase('error')
      }
    }

    start()

    return () => {
      cancelled = true
      // Transient unmount (StrictMode double-mount, hash change, parent
      // re-render). Tear down in-memory state and the WebSocket without
      // broadcasting a 'leave' message — that would tell the server we're
      // gone forever, but we may just be remounting. Explicit user leaves
      // go through endChat() which calls cleanup() with skipLeave=false.
      cleanup(true)
    }
  }, [roomId, role, creatorPubKeyOrShare]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Send functions ───

  const sendMessage = useCallback(async (text: string, replyTo?: string, timed?: boolean) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const msgId = generateMessageId()
    const ts = Date.now()
    const payloadObj: Record<string, unknown> = { kind: 'text', content: trimmed, msgId, ts }
    if (replyTo) payloadObj.replyTo = replyTo
    if (timed) payloadObj.timed = true

    await encryptAndSend(payloadObj)

    setMessages(prev => {
      const replyPreview = replyTo ? findReplyPreview(prev, replyTo) : undefined
      return insertSorted(prev, {
        ...buildTextMessage('self', trimmed, localUsernameRef.current ?? undefined, msgId, ts),
        replyTo,
        replyPreview,
        timed: timed || undefined,
      })
    })
  }, [encryptAndSend])

  const sendNotefade = useCallback(async (url: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const msgId = generateMessageId()
    const ts = Date.now()
    await encryptAndSend({ kind: 'notefade', url, msgId, ts })
    setMessages(prev => insertSorted(prev, buildNotefadeMessage(
      'self', url, localUsernameRef.current ?? undefined, msgId, ts,
    )))
  }, [encryptAndSend])

  const sendNotefadeChat = useCallback(async (url: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const msgId = generateMessageId()
    const ts = Date.now()
    await encryptAndSend({ kind: 'notefade-chat', url, msgId, ts })
    setMessages(prev => insertSorted(prev, buildNotefadeChatMessage(
      'self', url, localUsernameRef.current ?? undefined, msgId, ts,
    )))
  }, [encryptAndSend])

  const sendReaction = useCallback(async (msgId: string, emoji: string, action: 'add' | 'remove') => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'reaction', msgId, emoji, action })
    setMessages(prev => applyReaction(prev, msgId, emoji, action, true, myClientIdRef.current ?? undefined))
  }, [encryptAndSend])

  const removeTimedMessage = useCallback((targetMsgId: string) => {
    setMessages(prev => prev.filter(msg => msg.id !== targetMsgId))
  }, [])

  const sendTimedConsumed = useCallback(async (noteId: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'timed-consumed', noteId })
  }, [encryptAndSend])

  const sendNotefadeChatRevealed = useCallback(async (noteId: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'notefade-chat-revealed', noteId })
  }, [encryptAndSend])

  const sendNotefadeChatDestroyed = useCallback(async (noteId: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'notefade-chat-destroyed', noteId })
    setMessages(prev => prev.map(msg =>
      msg.id === noteId ? { ...msg, notefadeDestroyed: true } : msg
    ))
  }, [encryptAndSend])

  const sendVoiceSignal = useCallback(async (signal: VoiceSignal) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const signalRecord: Record<string, unknown> = JSON.parse(JSON.stringify(signal))
    await encryptAndSend(signalRecord)
  }, [encryptAndSend])

  const sendGroupVoiceSignal = useCallback(async (signal: Record<string, unknown>) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend(signal)
  }, [encryptAndSend])

  const sendDirectEncrypted = useCallback(async (targetId: string, payload: Record<string, unknown>) => {
    const gc = groupCryptoRef.current
    const ws = wsRef.current
    if (!gc || !ws) return
    const ratchet = gc.pairwiseRatchets.get(targetId)
    if (!ratchet) return
    const plaintext = new TextEncoder().encode(JSON.stringify(payload))
    const { state: newRatchet, header, iv, ciphertext } = await ratchetEncrypt(ratchet, plaintext)
    const newPairwise = new Map(gc.pairwiseRatchets)
    newPairwise.set(targetId, newRatchet)
    groupCryptoRef.current = { ...gc, pairwiseRatchets: newPairwise }
    ws.send({
      type: 'direct',
      targetId,
      payload: JSON.stringify({
        type: 'group-voice-key-delivery',
        header,
        payload: toBase64Url(concatBytes(iv, ciphertext)),
      }),
    })
  }, [])

  const sendBinaryFrame = useCallback((data: ArrayBuffer) => {
    wsRef.current?.sendBinary(data)
  }, [])

  const setOnBinaryMessage = useCallback((handler: ((data: ArrayBuffer) => void) | null) => {
    const ws = wsRef.current
    if (ws) ws.onBinaryMessage = handler
  }, [])

  const sendVoiceNote = useCallback(async (
    blob: Blob,
    durationMs: number,
    mimeType: string,
    timed?: boolean,
  ) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0 || bytes.length > VOICE_NOTE_MAX_BYTES) return

    const noteId = generateMessageId()
    const ts = Date.now()
    const chunks = chunkBytes(bytes, VOICE_NOTE_CHUNK_BYTES)

    // Send meta
    await encryptAndSend({
      kind: 'voice-note-meta', noteId, mimeType, durationMs,
      totalChunks: chunks.length, totalBytes: bytes.length,
      timed: timed || undefined, ts,
    })

    // Send chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (!chunk) continue
      await encryptAndSend({
        kind: 'voice-note-chunk', noteId, index: i, data: toBase64Url(chunk),
      })
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    // Send complete
    await encryptAndSend({ kind: 'voice-note-complete', noteId })

    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    setMessages(prev => insertSorted(prev, buildAudioMessage(
      'self', objectUrl, durationMs, localUsernameRef.current ?? undefined,
      noteId, timed, ts,
    )))
    void computeWaveform(blob).then(w => {
      setMessages(prev => prev.map(m => m.id === noteId ? { ...m, waveform: w } : m))
    })
  }, [encryptAndSend, trackAudioUrl])

  const sendFile = useCallback(async (file: File, timed?: boolean) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const maxBytes = fileMaxBytes(file.type)
    if (bytes.length === 0 || bytes.length > maxBytes) return

    const fileId = generateMessageId()
    const ts = Date.now()
    const chunks = chunkBytes(bytes, FILE_CHUNK_BYTES)

    // Show local message
    const objectUrl = URL.createObjectURL(file)
    trackFileUrl(objectUrl)
    const msgKind = detectFileKind(file.type)
    setMessages(prev => insertSorted(prev, {
      ...buildFileMessage(
        'self', msgKind, objectUrl, file.name,
        file.type || 'application/octet-stream', bytes.length,
        localUsernameRef.current ?? undefined, fileId, timed, ts,
      ),
      transferProgress: 0,
    }))

    // Send meta
    await encryptAndSend({
      kind: 'file-meta', fileId, fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: chunks.length, totalBytes: bytes.length,
      timed: timed || undefined, ts,
    })

    // Send chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (!chunk) continue
      await encryptAndSend({
        kind: 'file-chunk', fileId, index: i, data: toBase64Url(chunk),
      })
      const progress = (i + 1) / chunks.length
      setMessages(prev => prev.map(m =>
        m.id === fileId ? { ...m, transferProgress: progress } : m
      ))
      await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
    }

    // Send complete
    await encryptAndSend({ kind: 'file-complete', fileId })
    setMessages(prev => prev.map(m =>
      m.id === fileId ? { ...m, transferProgress: undefined } : m
    ))
    if (file.type.startsWith('audio/')) {
      void computeWaveform(file).then(w => {
        setMessages(prev => prev.map(m => m.id === fileId ? { ...m, waveform: w } : m))
      })
    }
  }, [encryptAndSend, trackFileUrl])

  const sendPoll = useCallback(async (
    question: string,
    questionEmoji: string,
    options: Array<{ text: string; emoji: string }>,
    allowMultiple: boolean,
  ) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const pollId = generateMessageId()
    const ts = Date.now()
    await encryptAndSend({
      kind: 'poll', pollId, question, questionEmoji, options, allowMultiple, ts,
    })
    setMessages(prev => insertSorted(prev, buildPollMessage(
      'self', pollId, question, questionEmoji, options, allowMultiple,
      localUsernameRef.current ?? undefined, ts,
    )))
  }, [encryptAndSend])

  const sendPollVote = useCallback(async (pollId: string, optionIndices: number[]) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'poll-vote', pollId, optionIndices })
    const previous = selfPollVotesRef.current.get(pollId) ?? []
    setMessages(prev => applyPollVote(prev, pollId, optionIndices, true, previous))
    selfPollVotesRef.current.set(pollId, optionIndices)
  }, [encryptAndSend])

  const sendPrediction = useCallback(async (
    title: string,
    options: string[],
    durationMs: number,
    mode: PredictionMode,
  ) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const predictionId = generateMessageId()
    const ts = Date.now()
    await encryptAndSend({ kind: 'prediction', predictionId, title, options, durationMs, ts, mode })
    setMessages(prev => insertSorted(prev, buildPredictionMessage(
      'self', predictionId, title, options, durationMs, mode,
      localUsernameRef.current ?? undefined, ts, groupCryptoRef.current?.myId,
    )))
  }, [encryptAndSend])

  const sendPredictionVote = useCallback(async (predictionId: string, optionIndex: number) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    if (selfPredictionVotesRef.current.has(predictionId)) return
    await encryptAndSend({ kind: 'prediction-vote', predictionId, optionIndex })
    const previous = selfPredictionVotesRef.current.get(predictionId)
    setMessages(prev => applyPredictionVote(prev, predictionId, optionIndex, true, previous))
    selfPredictionVotesRef.current.set(predictionId, optionIndex)
  }, [encryptAndSend])

  const sendPredictionOutcome = useCallback(async (predictionId: string, winnerIndex: number) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'prediction-outcome', predictionId, winnerIndex })
    setMessages(prev => applyPredictionOutcome(prev, predictionId, winnerIndex))
  }, [encryptAndSend])

  const sendPredictionDelete = useCallback(async (predictionId: string) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    await encryptAndSend({ kind: 'prediction-delete', predictionId })
    setMessages(prev => applyPredictionDelete(prev, predictionId))
  }, [encryptAndSend])

  const sendGallery = useCallback(async (
    files: File[],
    caption?: string,
    timed?: boolean,
    originalSizes?: number[],
  ) => {
    if (!groupCryptoRef.current || !wsRef.current) return
    const validFiles = files.slice(0, GALLERY_MAX_IMAGES).filter(f =>
      f.size > 0 && f.size <= FILE_MAX_IMAGE_BYTES && IMAGE_MIME_TYPES.has(f.type)
    )
    if (validFiles.length === 0) return

    const galleryId = generateMessageId()
    const ts = Date.now()

    const imageEntries = await Promise.all(validFiles.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const fileId = generateMessageId()
      const chunks = chunkBytes(bytes, FILE_CHUNK_BYTES)
      const objectUrl = URL.createObjectURL(file)
      trackFileUrl(objectUrl)
      return { file, bytes, fileId, chunks, objectUrl }
    }))

    // Send gallery-meta
    await encryptAndSend({
      kind: 'gallery-meta', galleryId,
      caption: caption || undefined,
      timed: timed || undefined, ts,
      images: imageEntries.map(e => ({
        fileId: e.fileId, fileName: e.file.name, mimeType: e.file.type,
        totalChunks: e.chunks.length, totalBytes: e.bytes.length,
      })),
    })

    // Show local gallery — includes originalSize so the sender's bubble can
    // show a "Compressed X → Y" hint. originalSizes is index-aligned with
    // imageEntries (caller passes them in the same order as `files`).
    setMessages(prev => insertSorted(prev, {
      id: galleryId, kind: 'gallery', text: caption || undefined,
      sender: 'self', displayName: localUsernameRef.current ?? undefined,
      timestamp: ts, reactions: [], timed: timed || undefined,
      gallery: imageEntries.map((e, i) => ({
        fileId: e.fileId, fileUrl: e.objectUrl, fileName: e.file.name,
        mimeType: e.file.type, fileSize: e.bytes.length,
        originalSize: originalSizes?.[i],
      })),
    }))

    // Send each image
    for (const entry of imageEntries) {
      await encryptAndSend({
        kind: 'file-meta', fileId: entry.fileId, fileName: entry.file.name,
        mimeType: entry.file.type, totalChunks: entry.chunks.length,
        totalBytes: entry.bytes.length, galleryId,
      })
      for (let i = 0; i < entry.chunks.length; i++) {
        const chunk = entry.chunks[i]
        if (!chunk) continue
        await encryptAndSend({
          kind: 'file-chunk', fileId: entry.fileId, index: i,
          data: toBase64Url(chunk), galleryId,
        })
        await new Promise(resolve => setTimeout(resolve, FILE_SEND_DELAY_MS))
      }
      await encryptAndSend({ kind: 'file-complete', fileId: entry.fileId, galleryId })
    }

    // Send gallery-complete
    await encryptAndSend({ kind: 'gallery-complete', galleryId })
  }, [encryptAndSend, trackFileUrl])

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
    cleanup(true)
    setPhase('room-closed')
    window.location.hash = ''
  }, [cleanup])

  // Backward-compat: expose peerUsername as first peer's username
  const peerUsername = peerUsernames.size > 0
    ? peerUsernames.values().next().value ?? null
    : null

  return {
    phase,
    messages,
    peerTyping,
    inviteUrl,
    sendMessage,
    sendReaction,
    removeTimedMessage,
    sendTimedConsumed,
    sendNotefadeChatRevealed,
    sendNotefadeChatDestroyed,
    sendNotefade,
    sendNotefadeChat,
    sendPoll,
    sendPollVote,
    sendPrediction,
    sendPredictionVote,
    sendPredictionOutcome,
    sendPredictionDelete,
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
    peerUsernames,
    setLocalUsername: setLocalUsernameAndNotify,
    mediaKeyRaw,
    error,
    participantCount,
    myClientId,
    myPubKeyRaw,
    peerPubKeys: peerPubKeysMap,
    sendGroupVoiceSignal,
    sendDirectEncrypted,
    sendBinaryFrame,
    setOnBinaryMessage,
  }
}
