import { useState, useRef, useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import { toBase64Url, fromBase64Url } from '@/crypto'
import { buf } from '@/crypto/buffer'
import {
  GROUP_VOICE_SAMPLE_RATE,
  GROUP_VOICE_FRAME_SIZE,
  GROUP_VOICE_MAGIC_BYTE,
  GROUP_VOICE_JITTER_BUFFER_SIZE,
  GROUP_VOICE_MAX_PARTICIPANTS,
} from '@/constants'

interface JitterBuffer {
  frames: Float32Array[]
  playbackNode: ScriptProcessorNode | null
}

interface UseGroupVoiceOptions {
  myClientId: string | null
  peerIds: string[]
  sendGroupVoiceSignal: (signal: Record<string, unknown>) => Promise<void>
  sendDirectEncrypted: (targetId: string, payload: Record<string, unknown>) => Promise<void>
  sendBinaryFrame: (data: ArrayBuffer) => void
  setOnBinaryMessage: (handler: ((data: ArrayBuffer) => void) | null) => void
  groupVoiceHandlerRef: RefObject<((signal: { kind: string; key?: string }, senderId: string) => void) | null>
}

export function useGroupVoice({
  myClientId,
  peerIds,
  sendGroupVoiceSignal,
  sendDirectEncrypted,
  sendBinaryFrame,
  setOnBinaryMessage,
  groupVoiceHandlerRef,
}: UseGroupVoiceOptions) {
  const [isInGroupVoice, setIsInGroupVoice] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [voiceParticipants, setVoiceParticipants] = useState<Set<string>>(new Set())

  const voiceKeyRef = useRef<CryptoKey | null>(null)
  const voiceKeyRawRef = useRef<Uint8Array | null>(null)
  const frameCounterRef = useRef(0)
  const sessionSaltRef = useRef(new Uint8Array(4))
  const localStreamRef = useRef<MediaStream | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const playbackCtxRef = useRef<AudioContext | null>(null)
  const jitterBuffersRef = useRef<Map<string, JitterBuffer>>(new Map())
  const isInVoiceRef = useRef(false)
  const isMutedRef = useRef(false)
  const myClientIdRef = useRef(myClientId)
  myClientIdRef.current = myClientId
  isMutedRef.current = isMuted

  // Import a raw key as AES-GCM CryptoKey
  const importVoiceKey = useCallback(async (raw: Uint8Array) => {
    const key = await crypto.subtle.importKey(
      'raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    )
    voiceKeyRef.current = key
    voiceKeyRawRef.current = raw
  }, [])

  // Build IV from session salt + counter
  const buildIv = useCallback((counter: number): Uint8Array => {
    const iv = new Uint8Array(12)
    iv.set(sessionSaltRef.current, 0)
    // bytes 4-7 zero
    iv[8] = (counter >>> 24) & 0xff
    iv[9] = (counter >>> 16) & 0xff
    iv[10] = (counter >>> 8) & 0xff
    iv[11] = counter & 0xff
    return iv
  }, [])

  // Convert Float32 PCM to Int16
  const float32ToInt16 = useCallback((float32: Float32Array): ArrayBuffer => {
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]!))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return int16.buffer
  }, [])

  // Convert Int16 PCM to Float32
  const int16ToFloat32 = useCallback((buffer: ArrayBuffer): Float32Array => {
    const int16 = new Int16Array(buffer)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i]! / (int16[i]! < 0 ? 0x8000 : 0x7fff)
    }
    return float32
  }, [])

  // Encrypt and send a voice frame
  const encryptAndSendFrame = useCallback(async (pcmFloat32: Float32Array) => {
    const key = voiceKeyRef.current
    if (!key || !myClientIdRef.current) return

    const pcmBytes = float32ToInt16(pcmFloat32)
    const counter = frameCounterRef.current++
    const iv = buildIv(counter)

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buf(iv) },
      key,
      pcmBytes,
    )

    // Pack: [magic(1) | senderIdLen(1) | senderId(N) | counter(4) | iv(12) | encrypted+tag]
    const senderIdBytes = new TextEncoder().encode(myClientIdRef.current)
    const counterBytes = new Uint8Array(4)
    counterBytes[0] = (counter >>> 24) & 0xff
    counterBytes[1] = (counter >>> 16) & 0xff
    counterBytes[2] = (counter >>> 8) & 0xff
    counterBytes[3] = counter & 0xff

    const totalLen = 1 + 1 + senderIdBytes.length + 4 + 12 + encrypted.byteLength
    const frame = new Uint8Array(totalLen)
    let offset = 0
    frame[offset++] = GROUP_VOICE_MAGIC_BYTE
    frame[offset++] = senderIdBytes.length
    frame.set(senderIdBytes, offset); offset += senderIdBytes.length
    frame.set(counterBytes, offset); offset += 4
    frame.set(iv, offset); offset += 12
    frame.set(new Uint8Array(encrypted), offset)

    sendBinaryFrame(frame.buffer)
  }, [buildIv, float32ToInt16, sendBinaryFrame])

  // Handle incoming binary voice frame
  const handleBinaryMessage = useCallback(async (data: ArrayBuffer) => {
    const bytes = new Uint8Array(data)
    if (bytes.length < 2 || bytes[0] !== GROUP_VOICE_MAGIC_BYTE) return

    const key = voiceKeyRef.current
    if (!key) return

    let offset = 1
    const senderIdLen = bytes[offset++]!
    const senderId = new TextDecoder().decode(bytes.slice(offset, offset + senderIdLen))
    offset += senderIdLen

    // Skip own frames
    if (senderId === myClientIdRef.current) return

    // Parse counter and IV
    offset += 4 // skip counter (we don't need it for decryption since IV is included)
    const iv = bytes.slice(offset, offset + 12)
    offset += 12
    const encrypted = bytes.slice(offset)

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf(iv) },
        key,
        buf(encrypted),
      )

      const pcm = int16ToFloat32(decrypted)

      // Push to jitter buffer
      const jb = jitterBuffersRef.current.get(senderId)
      if (jb) {
        jb.frames.push(pcm)
        // Keep buffer bounded
        while (jb.frames.length > GROUP_VOICE_JITTER_BUFFER_SIZE * 2) {
          jb.frames.shift()
        }
      }
    } catch {
      // Decryption failed — corrupted or wrong key, skip
    }
  }, [int16ToFloat32])

  // Create a playback node for a sender
  const createPlaybackNode = useCallback((senderId: string) => {
    const ctx = playbackCtxRef.current
    if (!ctx) return

    const jb: JitterBuffer = { frames: [], playbackNode: null }

    const processor = ctx.createScriptProcessor(GROUP_VOICE_FRAME_SIZE, 0, 1)
    processor.onaudioprocess = (e) => {
      const output = e.outputBuffer.getChannelData(0)
      const frame = jb.frames.shift()
      if (frame && frame.length === output.length) {
        output.set(frame)
      } else {
        // Silence when buffer is empty
        output.fill(0)
      }
    }
    processor.connect(ctx.destination)
    jb.playbackNode = processor

    jitterBuffersRef.current.set(senderId, jb)
  }, [])

  // Remove playback node for a sender
  const removePlaybackNode = useCallback((senderId: string) => {
    const jb = jitterBuffersRef.current.get(senderId)
    if (jb?.playbackNode) {
      jb.playbackNode.disconnect()
    }
    jitterBuffersRef.current.delete(senderId)
  }, [])

  // Start audio capture
  const startCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    localStreamRef.current = stream

    const ctx = new AudioContext({ sampleRate: GROUP_VOICE_SAMPLE_RATE })
    captureCtxRef.current = ctx

    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(GROUP_VOICE_FRAME_SIZE, 1, 1)

    processor.onaudioprocess = (e) => {
      if (!isMutedRef.current && isInVoiceRef.current) {
        const input = e.inputBuffer.getChannelData(0)
        void encryptAndSendFrame(new Float32Array(input))
      }
    }

    source.connect(processor)
    processor.connect(ctx.destination) // needed for onaudioprocess to fire
    captureProcessorRef.current = processor
  }, [encryptAndSendFrame])

  // Stop audio capture
  const stopCapture = useCallback(() => {
    captureProcessorRef.current?.disconnect()
    captureProcessorRef.current = null
    captureCtxRef.current?.close().catch(() => {})
    captureCtxRef.current = null
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
  }, [])

  // Join group voice
  const joinGroupVoice = useCallback(async () => {
    if (isInVoiceRef.current || !myClientId) return
    if (voiceParticipants.size >= GROUP_VOICE_MAX_PARTICIPANTS) return

    isInVoiceRef.current = true
    setIsInGroupVoice(true)
    frameCounterRef.current = 0
    crypto.getRandomValues(sessionSaltRef.current)

    // Generate voice session key if we're the first (no existing participants)
    if (voiceParticipants.size === 0) {
      const raw = crypto.getRandomValues(new Uint8Array(32))
      await importVoiceKey(raw)
    }

    // Announce join via encrypted text channel
    await sendGroupVoiceSignal({ kind: 'group-voice-join' })

    // Distribute key to all current peers
    if (voiceKeyRawRef.current) {
      const keyB64 = toBase64Url(voiceKeyRawRef.current)
      for (const peerId of peerIds) {
        await sendDirectEncrypted(peerId, { kind: 'group-voice-key', key: keyB64 })
      }
    }

    // Start playback context
    playbackCtxRef.current = new AudioContext({ sampleRate: GROUP_VOICE_SAMPLE_RATE })

    // Create playback nodes for existing voice participants
    for (const pid of voiceParticipants) {
      createPlaybackNode(pid)
    }

    // Start capture
    await startCapture()

    // Register binary message handler
    setOnBinaryMessage(handleBinaryMessage)
  }, [
    myClientId, voiceParticipants, peerIds, importVoiceKey,
    sendGroupVoiceSignal, sendDirectEncrypted, createPlaybackNode,
    startCapture, setOnBinaryMessage, handleBinaryMessage,
  ])

  // Leave group voice
  const leaveGroupVoice = useCallback(async () => {
    if (!isInVoiceRef.current) return
    isInVoiceRef.current = false
    setIsInGroupVoice(false)

    // Announce leave
    await sendGroupVoiceSignal({ kind: 'group-voice-leave' })

    // Stop capture and playback
    stopCapture()
    setOnBinaryMessage(null)

    for (const [id] of jitterBuffersRef.current) {
      removePlaybackNode(id)
    }
    playbackCtxRef.current?.close().catch(() => {})
    playbackCtxRef.current = null

    voiceKeyRef.current = null
    voiceKeyRawRef.current = null
    setVoiceParticipants(new Set())
  }, [sendGroupVoiceSignal, stopCapture, setOnBinaryMessage, removePlaybackNode])

  // Toggle mute
  const toggleMute = useCallback(() => {
    setIsMuted(prev => !prev)
  }, [])

  // Handle incoming group voice signals (from encrypted text channel)
  useEffect(() => {
    groupVoiceHandlerRef.current = async (signal, senderId) => {
      if (signal.kind === 'group-voice-join') {
        setVoiceParticipants(prev => {
          const next = new Set(prev)
          next.add(senderId)
          return next
        })

        // If we're in the call and have the key, send it to the new joiner
        if (isInVoiceRef.current && voiceKeyRawRef.current) {
          const keyB64 = toBase64Url(voiceKeyRawRef.current)
          await sendDirectEncrypted(senderId, { kind: 'group-voice-key', key: keyB64 })

          // Create playback node for the new participant
          if (playbackCtxRef.current) {
            createPlaybackNode(senderId)
          }
        }
      } else if (signal.kind === 'group-voice-leave') {
        setVoiceParticipants(prev => {
          const next = new Set(prev)
          next.delete(senderId)
          return next
        })
        removePlaybackNode(senderId)
      } else if (signal.kind === 'group-voice-key' && signal.key) {
        // Received voice session key from a peer
        const raw = fromBase64Url(signal.key)
        await importVoiceKey(raw)
      }
    }

    return () => {
      groupVoiceHandlerRef.current = null
    }
  }, [groupVoiceHandlerRef, sendDirectEncrypted, importVoiceKey, createPlaybackNode, removePlaybackNode])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isInVoiceRef.current) {
        stopCapture()
        for (const [id] of jitterBuffersRef.current) {
          removePlaybackNode(id)
        }
        playbackCtxRef.current?.close().catch(() => {})
      }
    }
  }, [stopCapture, removePlaybackNode])

  return {
    isInGroupVoice,
    isMuted,
    voiceParticipants,
    joinGroupVoice,
    leaveGroupVoice,
    toggleMute,
  }
}
