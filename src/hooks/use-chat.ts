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
} from '@/crypto'
import { createWebSocket } from '@/ws/client'
import type { ChatWebSocket, ClientMessage, ServerMessage } from '@/ws'
import type { RatchetState, VoiceSignal } from '@/types'
import { createRoom, buildWsUrl, buildInviteFragment } from '@/api'
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
  | 'expired'
  | 'room-closed'
  | 'error'

export interface ChatMessage {
  id: string
  kind: 'text' | 'audio'
  text?: string
  audioUrl?: string
  durationMs?: number
  sender: 'self' | 'peer' | 'system'
  timestamp: number
}

const SALT = new TextEncoder().encode('yapgone-chat-root')
const INFO = new Uint8Array(0)

const DecryptedPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), content: z.string() }),
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
): ChatMessage {
  return {
    id: generateMessageId(),
    kind: 'audio',
    audioUrl: objectUrl,
    durationMs,
    sender,
    timestamp: Date.now(),
  }
}

function buildTextMessage(sender: 'self' | 'peer' | 'system', text: string): ChatMessage {
  return {
    id: generateMessageId(),
    kind: 'text',
    text,
    sender,
    timestamp: Date.now(),
  }
}

const TYPING_SAFETY_TIMEOUT = 30_000

export function useChatAsCreator(voiceHandlerRef?: VoiceHandlerRef) {
  const [phase, setPhase] = useState<ChatPhase>('creating')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<ChatWebSocket | null>(null)
  const ratchetRef = useRef<RatchetState | null>(null)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)
  const cleanedUpRef = useRef(false)
  const typingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceNoteAssembliesRef = useRef<Map<string, VoiceNoteAssembly>>(new Map())
  const localAudioUrlsRef = useRef<Set<string>>(new Set())

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
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
    const blob = new Blob([arrayBuffer], { type: assembly.mimeType })
    const objectUrl = URL.createObjectURL(blob)
    trackAudioUrl(objectUrl)
    setMessages(prev => [...prev, buildAudioMessage(sender, objectUrl, assembly.durationMs)])
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

        const pubKeyRaw = await exportPublicKey(kp.publicKey)
        const pubKeyB64 = toBase64Url(pubKeyRaw)
        const fragment = buildInviteFragment(roomId, pubKeyB64)
        const url = `${window.location.origin}${window.location.pathname}#${fragment}`
        setInviteUrl(url)
        window.location.hash = fragment

        // Mark as creator in sessionStorage
        sessionStorage.setItem(`yapgone-creator-${roomId}`, '1')

        setPhase('waiting')

        // Connect WebSocket
        const ws = createWebSocket()
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
          if (phase !== 'peer-left' && phase !== 'error') {
            if (reason === 'Room expired') {
              setPhase('expired')
            }
          }
        }

        ws.onError = () => {
          if (cancelled) return
          setError('Connection failed')
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
        setPhase('key-exchange')
        return
      }

      if (msg.type === 'peer-left') {
        setMessages(prev => [...prev, buildTextMessage('system', 'Your partner left the chat')])
        setPhase('peer-left')
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
          if (result.data.kind === 'text') {
            const textPayload = z.object({
              kind: z.literal('text'),
              content: z.string(),
            }).safeParse(result.data)
            if (!textPayload.success) return
            setMessages(prev => [...prev, buildTextMessage('peer', textPayload.data.content)])
          } else if (
            result.data.kind === 'voice-note-meta' ||
            result.data.kind === 'voice-note-chunk' ||
            result.data.kind === 'voice-note-complete'
          ) {
            onVoiceNotePayload(result.data, 'peer')
          } else {
            voiceHandlerRef?.current?.(result.data)
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

  const sendMessage = useCallback(async (text: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'text', content: trimmed }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState

    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    setMessages(prev => [...prev, {
      ...buildTextMessage('self', trimmed),
    }])
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
    setMessages(prev => [...prev, buildAudioMessage('self', objectUrl, durationMs)])
  }, [trackAudioUrl])

  const sendTyping = useCallback((active: boolean) => {
    wsRef.current?.send({ type: 'typing', active })
  }, [])

  const endChat = useCallback(() => {
    cleanup()
    setPhase('peer-left')
    window.location.hash = ''
  }, [cleanup])

  const endChatForAll = useCallback(() => {
    if (wsRef.current) {
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
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    endChat,
    endChatForAll,
    error,
  }
}

export function useChatAsJoiner(roomId: string, creatorPubKeyB64: string, voiceHandlerRef?: VoiceHandlerRef) {
  const [phase, setPhase] = useState<ChatPhase>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [peerTyping, setPeerTyping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<ChatWebSocket | null>(null)
  const ratchetRef = useRef<RatchetState | null>(null)
  const cleanedUpRef = useRef(false)
  const typingSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceNoteAssembliesRef = useRef<Map<string, VoiceNoteAssembly>>(new Map())
  const localAudioUrlsRef = useRef<Set<string>>(new Set())

  const trackAudioUrl = useCallback((url: string) => {
    localAudioUrlsRef.current.add(url)
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
    setMessages(prev => [...prev, buildAudioMessage(sender, objectUrl, assembly.durationMs)])
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

        if (cancelled) return

        // Connect WebSocket
        const ws = createWebSocket()
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

        ws.connect(buildWsUrl(roomId))
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unknown error')
        setPhase('error')
      }
    }

    async function handleJoinerMessage(msg: ServerMessage | ClientMessage) {
      if (msg.type === 'peer-left') {
        setMessages(prev => [...prev, buildTextMessage('system', 'Your partner left the chat')])
        setPhase('peer-left')
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
          if (result.data.kind === 'text') {
            const textPayload = z.object({
              kind: z.literal('text'),
              content: z.string(),
            }).safeParse(result.data)
            if (!textPayload.success) return
            setMessages(prev => [...prev, buildTextMessage('peer', textPayload.data.content)])
          } else if (
            result.data.kind === 'voice-note-meta' ||
            result.data.kind === 'voice-note-chunk' ||
            result.data.kind === 'voice-note-complete'
          ) {
            onVoiceNotePayload(result.data, 'peer')
          } else {
            voiceHandlerRef?.current?.(result.data)
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

  const sendMessage = useCallback(async (text: string) => {
    if (!ratchetRef.current || !wsRef.current) return
    const trimmed = text.slice(0, MAX_MESSAGE_LENGTH)
    if (!trimmed) return

    const plaintext = new TextEncoder().encode(
      JSON.stringify({ kind: 'text', content: trimmed }),
    )
    const { state: newState, header, iv, ciphertext } = await ratchetEncrypt(
      ratchetRef.current,
      plaintext,
    )
    ratchetRef.current = newState

    const payload = toBase64Url(concatBytes(iv, ciphertext))
    wsRef.current.send({ type: 'message', header, payload })

    setMessages(prev => [...prev, {
      ...buildTextMessage('self', trimmed),
    }])
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
    setMessages(prev => [...prev, buildAudioMessage('self', objectUrl, durationMs)])
  }, [trackAudioUrl])

  const sendTyping = useCallback((active: boolean) => {
    wsRef.current?.send({ type: 'typing', active })
  }, [])

  const endChat = useCallback(() => {
    cleanup()
    setPhase('peer-left')
    window.location.hash = ''
  }, [cleanup])

  const endChatForAll = useCallback(() => {
    if (wsRef.current) {
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
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    endChat,
    endChatForAll,
    error,
  }
}
