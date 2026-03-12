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
import { createRoom, buildWsUrl, buildInviteFragment } from '@/api'
import type { RoomSettings } from '@/room-settings'
import { DEFAULT_ROOM_SETTINGS, normalizeRoomSettings } from '@/room-settings'
import {
  MAX_MESSAGE_LENGTH,
  VOICE_NOTE_ASSEMBLY_TIMEOUT_MS,
  VOICE_NOTE_CHUNK_BYTES,
  VOICE_NOTE_MAX_BYTES,
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

export interface ChatMessage {
  id: string
  kind: 'text' | 'audio'
  text?: string
  audioUrl?: string
  durationMs?: number
  sender: 'self' | 'peer' | 'system'
  displayName?: string
  timestamp: number
  reactions: MessageReaction[]
  replyTo?: string
  replyPreview?: string
}

const SALT = new TextEncoder().encode('yapgone-chat-root')
const INFO = new Uint8Array(0)

const DecryptedPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    content: z.string(),
    msgId: z.string().min(1).max(32).optional(),
    replyTo: z.string().min(1).max(32).optional(),
  }),
  z.object({
    kind: z.literal('voice-note-meta'),
    noteId: z.string().min(1),
    mimeType: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    totalChunks: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
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
  z.object({ kind: z.literal('username-set'), username: z.string().min(1).max(24) }),
  z.object({
    kind: z.literal('reaction'),
    msgId: z.string().min(1).max(32),
    emoji: z.string().min(1).max(8),
    action: z.enum(['add', 'remove']),
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

interface VoiceNoteAssembly {
  mimeType: string
  durationMs: number
  totalChunks: number
  totalBytes: number
  receivedBytes: number
  chunks: Map<number, Uint8Array>
  createdAt: number
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

function buildAudioMessage(
  sender: 'self' | 'peer',
  objectUrl: string,
  durationMs: number,
  displayName?: string,
  id?: string,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'audio',
    audioUrl: objectUrl,
    durationMs,
    sender,
    displayName,
    timestamp: Date.now(),
    reactions: [],
  }
}

function buildTextMessage(
  sender: 'self' | 'peer' | 'system',
  text: string,
  displayName?: string,
  id?: string,
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    kind: 'text',
    text,
    sender,
    displayName,
    timestamp: Date.now(),
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
  const text = target.text ?? ''
  return text.length > 80 ? text.slice(0, 80) + '...' : text
}

const TYPING_SAFETY_TIMEOUT = 30_000

export function useChatAsCreator(
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

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
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
    setMessages(prev => [...prev, buildAudioMessage(
      sender,
      objectUrl,
      assembly.durationMs,
      sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
      payload.noteId,
    )])
    voiceNoteAssembliesRef.current.delete(payload.noteId)
  }, [cleanupVoiceNoteAssemblies, trackAudioUrl])

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
    for (const url of localAudioUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localAudioUrlsRef.current.clear()
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

        const roomId = await createRoom()
        if (cancelled) return
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
            setMessages(prev => {
              const replyPreview = replyToId
                ? findReplyPreview(prev, replyToId)
                : undefined
              return [...prev, {
                ...buildTextMessage('peer', content, peerUsernameRef.current ?? undefined, id),
                replyTo: replyToId,
                replyPreview,
              }]
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

  const sendMessage = useCallback(async (text: string, replyTo?: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const msgId = generateMessageId()
    const payloadObj: Record<string, unknown> = { kind: 'text', content: trimmed, msgId }
    if (replyTo) payloadObj.replyTo = replyTo

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
      return [...prev, {
        ...buildTextMessage('self', trimmed, localUsernameRef.current ?? undefined, msgId),
        replyTo,
        replyPreview,
      }]
    })
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
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0 || bytes.length > VOICE_NOTE_MAX_BYTES) return

    const noteId = generateMessageId()
    const chunks = _chunkBytes(bytes, VOICE_NOTE_CHUNK_BYTES)
    const meta: VoiceNoteMeta = {
      kind: 'voice-note-meta',
      noteId,
      mimeType,
      durationMs,
      totalChunks: chunks.length,
      totalBytes: bytes.length,
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
    setMessages(prev => [...prev, buildAudioMessage(
      'self',
      objectUrl,
      durationMs,
      localUsernameRef.current ?? undefined,
      noteId,
    )])
  }, [trackAudioUrl])

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
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
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

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
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
    setMessages(prev => [...prev, buildAudioMessage(
      sender,
      objectUrl,
      assembly.durationMs,
      sender === 'peer' ? peerUsernameRef.current ?? undefined : localUsernameRef.current ?? undefined,
      payload.noteId,
    )])
    voiceNoteAssembliesRef.current.delete(payload.noteId)
  }, [cleanupVoiceNoteAssemblies, trackAudioUrl])

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
    for (const url of localAudioUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
    localAudioUrlsRef.current.clear()
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
            setMessages(prev => {
              const replyPreview = replyToId
                ? findReplyPreview(prev, replyToId)
                : undefined
              return [...prev, {
                ...buildTextMessage('peer', content, peerUsernameRef.current ?? undefined, id),
                replyTo: replyToId,
                replyPreview,
              }]
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

  const sendMessage = useCallback(async (text: string, replyTo?: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const msgId = generateMessageId()
    const payloadObj: Record<string, unknown> = { kind: 'text', content: trimmed, msgId }
    if (replyTo) payloadObj.replyTo = replyTo

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
      return [...prev, {
        ...buildTextMessage('self', trimmed, localUsernameRef.current ?? undefined, msgId),
        replyTo,
        replyPreview,
      }]
    })
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
  ) => {
    if (!ratchetRef.current || !wsRef.current) return
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0 || bytes.length > VOICE_NOTE_MAX_BYTES) return

    const noteId = generateMessageId()
    const chunks = _chunkBytes(bytes, VOICE_NOTE_CHUNK_BYTES)
    const meta: VoiceNoteMeta = {
      kind: 'voice-note-meta',
      noteId,
      mimeType,
      durationMs,
      totalChunks: chunks.length,
      totalBytes: bytes.length,
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
    setMessages(prev => [...prev, buildAudioMessage(
      'self',
      objectUrl,
      durationMs,
      localUsernameRef.current ?? undefined,
      noteId,
    )])
  }, [trackAudioUrl])

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
    sendReaction,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
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
