import { useState, useRef, useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import type { VoiceSignal, CallState } from '@/types'
import { z } from 'zod'
import {
  VOICE_CONNECT_TIMEOUT_MS,
  VOICE_DISCONNECTED_GRACE_MS,
} from '@/constants'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

const SdpInitSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string().optional(),
})

const IceCandidateInitSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
})

interface UseVoiceCallOptions {
  sendSignal: (signal: VoiceSignal) => void
  onSignalRef: RefObject<((signal: VoiceSignal) => void) | null>
  peerConnected: boolean
}

export type IceHandlingStrategy = 'buffer-pre-pc' | 'buffer-pre-remote' | 'apply-now'

export function _getIceHandlingStrategy(
  hasPeerConnection: boolean,
  hasRemoteDescription: boolean,
): IceHandlingStrategy {
  if (!hasPeerConnection) return 'buffer-pre-pc'
  if (!hasRemoteDescription) return 'buffer-pre-remote'
  return 'apply-now'
}

export function _shouldFailForConnectionState(
  callState: CallState,
  iceState: RTCIceConnectionState,
): boolean {
  if (callState !== 'active' && callState !== 'connecting') return false
  return iceState === 'failed'
}

export function _shouldStartDisconnectedGrace(
  callState: CallState,
  iceState: RTCIceConnectionState,
  hasExistingGraceTimer: boolean,
): boolean {
  if (hasExistingGraceTimer) return false
  if (callState !== 'active' && callState !== 'connecting') return false
  return iceState === 'disconnected'
}

export function _canEnterRingingOnIncoming(callState: CallState): boolean {
  return callState === 'idle' || callState === 'ended' || callState === 'failed' || callState === 'requesting'
}

export function useVoiceCall({
  sendSignal,
  onSignalRef,
  peerConnected,
}: UseVoiceCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [callDuration, setCallDuration] = useState(0)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const connectingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disconnectedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callStartRef = useRef(0)
  const stateRef = useRef<CallState>('idle')
  const prePcIceCandidatesRef = useRef<z.infer<typeof IceCandidateInitSchema>[]>([])
  const preRemoteDescIceCandidatesRef = useRef<z.infer<typeof IceCandidateInitSchema>[]>([])
  const pendingOfferRef = useRef<string | null>(null)
  const pendingAnswerRef = useRef<string | null>(null)

  stateRef.current = callState

  const clearConnectingTimeout = useCallback(() => {
    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current)
      connectingTimeoutRef.current = null
    }
  }, [])

  const clearDisconnectedTimeout = useCallback(() => {
    if (disconnectedTimeoutRef.current) {
      clearTimeout(disconnectedTimeoutRef.current)
      disconnectedTimeoutRef.current = null
    }
  }, [])

  const failCall = useCallback((notifyPeer: boolean) => {
    if (notifyPeer) {
      sendSignal({ kind: 'voice-end' })
    }
    clearConnectingTimeout()
    clearDisconnectedTimeout()
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current)
      durationIntervalRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
    }
    prePcIceCandidatesRef.current = []
    preRemoteDescIceCandidatesRef.current = []
    pendingOfferRef.current = null
    pendingAnswerRef.current = null
    setIsMuted(false)
    setCallDuration(0)
    callStartRef.current = 0
    setCallState('failed')
  }, [sendSignal, clearConnectingTimeout, clearDisconnectedTimeout])

  const cleanupCall = useCallback(() => {
    clearConnectingTimeout()
    clearDisconnectedTimeout()
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current)
      durationIntervalRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
    }
    prePcIceCandidatesRef.current = []
    preRemoteDescIceCandidatesRef.current = []
    pendingOfferRef.current = null
    pendingAnswerRef.current = null
    setIsMuted(false)
    setCallDuration(0)
    callStartRef.current = 0
  }, [clearConnectingTimeout, clearDisconnectedTimeout])

  const startDurationTimer = useCallback(() => {
    callStartRef.current = Date.now()
    setCallDuration(0)
    durationIntervalRef.current = setInterval(() => {
      setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000))
    }, 1000)
  }, [])

  const addIceCandidateSafe = useCallback(async (
    pc: RTCPeerConnection,
    candidate: z.infer<typeof IceCandidateInitSchema>,
  ) => {
    try {
      await pc.addIceCandidate(candidate)
    } catch {
      // non-fatal
    }
  }, [])

  const flushRemoteIceCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const buffered = preRemoteDescIceCandidatesRef.current
    preRemoteDescIceCandidatesRef.current = []
    for (const c of buffered) {
      await addIceCandidateSafe(pc, c)
    }
  }, [addIceCandidateSafe])

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          kind: 'ice-candidate',
          candidate: JSON.stringify(event.candidate.toJSON()),
        })
      }
    }

    pc.ontrack = (event) => {
      if (!remoteAudioRef.current) {
        remoteAudioRef.current = new Audio()
        remoteAudioRef.current.autoplay = true
      }
      remoteAudioRef.current.srcObject =
        event.streams[0] ?? new MediaStream([event.track])
    }

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState
      if (iceState === 'connected' || iceState === 'completed') {
        clearDisconnectedTimeout()
        if (stateRef.current === 'connecting') {
          clearConnectingTimeout()
          setCallState('active')
          startDurationTimer()
        }
      }
      if (_shouldFailForConnectionState(stateRef.current, iceState)) {
        failCall(true)
      }
      if (_shouldStartDisconnectedGrace(
        stateRef.current,
        iceState,
        Boolean(disconnectedTimeoutRef.current),
      )) {
        disconnectedTimeoutRef.current = setTimeout(() => {
          const currentPc = pcRef.current
          if (!currentPc) return
          if (
            stateRef.current !== 'active' &&
            stateRef.current !== 'connecting'
          ) {
            return
          }
          if (
            currentPc.iceConnectionState === 'disconnected' ||
            currentPc.iceConnectionState === 'failed'
          ) {
            failCall(true)
          }
        }, VOICE_DISCONNECTED_GRACE_MS)
      }
    }

    pcRef.current = pc

    const prePc = prePcIceCandidatesRef.current
    prePcIceCandidatesRef.current = []
    if (prePc.length > 0) {
      preRemoteDescIceCandidatesRef.current.push(...prePc)
    }

    return pc
  }, [
    clearDisconnectedTimeout,
    clearConnectingTimeout,
    failCall,
    startDurationTimer,
  ])

  const acquireMedia = useCallback(async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    localStreamRef.current = stream
    return stream
  }, [])

  const applyOffer = useCallback(async (pc: RTCPeerConnection, sdp: string) => {
    const offer = SdpInitSchema.parse(JSON.parse(sdp))
    await pc.setRemoteDescription(offer)
    await flushRemoteIceCandidates(pc)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendSignal({ kind: 'sdp-answer', sdp: JSON.stringify(answer) })
  }, [flushRemoteIceCandidates, sendSignal])

  const applyAnswer = useCallback(async (pc: RTCPeerConnection, sdp: string) => {
    const answer = SdpInitSchema.parse(JSON.parse(sdp))
    await pc.setRemoteDescription(answer)
    await flushRemoteIceCandidates(pc)
  }, [flushRemoteIceCandidates])

  const startCall = useCallback(() => {
    if (stateRef.current !== 'idle') return
    sendSignal({ kind: 'voice-request' })
    setCallState('requesting')
  }, [sendSignal])

  const acceptCall = useCallback(async () => {
    if (stateRef.current !== 'ringing') return
    try {
      setCallState('connecting')
      sendSignal({ kind: 'voice-accept' })
      const stream = await acquireMedia()
      const pc = createPeerConnection()
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
      const pendingOffer = pendingOfferRef.current
      if (pendingOffer) {
        pendingOfferRef.current = null
        await applyOffer(pc, pendingOffer)
      }
    } catch {
      cleanupCall()
      setCallState('failed')
    }
  }, [acquireMedia, applyOffer, createPeerConnection, sendSignal, cleanupCall])

  const declineCall = useCallback(() => {
    if (stateRef.current !== 'ringing') return
    sendSignal({ kind: 'voice-decline' })
    setCallState('idle')
  }, [sendSignal])

  const endCall = useCallback(() => {
    const s = stateRef.current
    if (s === 'idle' || s === 'ended' || s === 'failed') return
    sendSignal({ kind: 'voice-end' })
    cleanupCall()
    setCallState('ended')
  }, [sendSignal, cleanupCall])

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (!audioTrack) return
    audioTrack.enabled = !audioTrack.enabled
    setIsMuted(!audioTrack.enabled)
  }, [])

  const acknowledgePrivacy = useCallback(() => {
    setPrivacyAcknowledged(true)
  }, [])

  const resetCallState = useCallback(() => {
    if (stateRef.current === 'ended' || stateRef.current === 'failed') {
      setCallState('idle')
    }
  }, [])

  const handleSignal = useCallback(async (signal: VoiceSignal) => {
    switch (signal.kind) {
      case 'voice-request': {
        if (_canEnterRingingOnIncoming(stateRef.current)) {
          clearConnectingTimeout()
          clearDisconnectedTimeout()
          if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current)
            durationIntervalRef.current = null
          }
          setCallState('ringing')
        }
        break
      }

      case 'voice-accept': {
        if (stateRef.current !== 'requesting') break
        try {
          setCallState('connecting')
          const stream = await acquireMedia()
          const pc = createPeerConnection()
          stream.getTracks().forEach(t => pc.addTrack(t, stream))
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
          const pendingAnswer = pendingAnswerRef.current
          if (pendingAnswer) {
            pendingAnswerRef.current = null
            await applyAnswer(pc, pendingAnswer)
          }
        } catch {
          cleanupCall()
          setCallState('failed')
        }
        break
      }

      case 'voice-decline': {
        if (stateRef.current === 'requesting') {
          cleanupCall()
          setCallState('ended')
        }
        break
      }

      case 'sdp-offer': {
        if (stateRef.current !== 'connecting') break
        if (!pcRef.current) {
          pendingOfferRef.current = signal.sdp
          break
        }
        try {
          await applyOffer(pcRef.current, signal.sdp)
        } catch {
          cleanupCall()
          setCallState('failed')
        }
        break
      }

      case 'sdp-answer': {
        if (stateRef.current !== 'connecting') break
        if (!pcRef.current) {
          pendingAnswerRef.current = signal.sdp
          break
        }
        try {
          await applyAnswer(pcRef.current, signal.sdp)
        } catch {
          cleanupCall()
          setCallState('failed')
        }
        break
      }

      case 'ice-candidate': {
        try {
          const candidate = IceCandidateInitSchema.parse(
            JSON.parse(signal.candidate),
          )
          const strategy = _getIceHandlingStrategy(
            Boolean(pcRef.current),
            Boolean(pcRef.current?.remoteDescription),
          )
          if (strategy === 'buffer-pre-pc') {
            prePcIceCandidatesRef.current.push(candidate)
          } else if (strategy === 'apply-now') {
            if (!pcRef.current) break
            await addIceCandidateSafe(pcRef.current, candidate)
          } else {
            preRemoteDescIceCandidatesRef.current.push(candidate)
          }
        } catch {
          // non-fatal
        }
        break
      }

      case 'voice-end': {
        const s = stateRef.current
        if (s !== 'idle' && s !== 'ended' && s !== 'failed') {
          cleanupCall()
          setCallState('ended')
        }
        break
      }
    }
  }, [
    acquireMedia,
    addIceCandidateSafe,
    applyAnswer,
    applyOffer,
    createPeerConnection,
    sendSignal,
    cleanupCall,
  ])

  // Register signal handler
  useEffect(() => {
    onSignalRef.current = handleSignal
    return () => {
      onSignalRef.current = null
    }
  }, [handleSignal, onSignalRef])

  // Cleanup on unmount
  useEffect(() => {
    return () => { cleanupCall() }
  }, [cleanupCall])

  // End call if peer disconnects
  useEffect(() => {
    if (!peerConnected) {
      const s = stateRef.current
      if (s !== 'idle' && s !== 'ended' && s !== 'failed') {
        cleanupCall()
        setCallState('ended')
      }
    }
  }, [peerConnected, cleanupCall])

  // Watchdog for stalled connection attempts
  useEffect(() => {
    clearConnectingTimeout()
    if (callState === 'connecting') {
      connectingTimeoutRef.current = setTimeout(() => {
        if (stateRef.current === 'connecting') {
          failCall(true)
        }
      }, VOICE_CONNECT_TIMEOUT_MS)
    }
    return () => {
      clearConnectingTimeout()
    }
  }, [callState, clearConnectingTimeout, failCall])

  return {
    callState,
    isMuted,
    callDuration,
    privacyAcknowledged,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    acknowledgePrivacy,
    resetCallState,
  }
}
