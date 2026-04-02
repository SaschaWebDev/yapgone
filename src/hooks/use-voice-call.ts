import { useState, useRef, useCallback, useEffect } from 'react'
import type { RefObject } from 'react'
import type { VoiceSignal, CallState } from '@/types'
import { buf } from '@/crypto/buffer'
import { createMediaCryptoWorker } from '@/workers/create-media-crypto-worker'
import { z } from 'zod'
import {
  VOICE_CONNECT_TIMEOUT_MS,
  VOICE_DISCONNECTED_GRACE_MS,
  VOICE_E2EE_ENABLED,
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
  onSignalRef: RefObject<((signal: VoiceSignal, senderId: string) => void) | null>
  peerConnected: boolean
  mediaKeyRaw: Uint8Array | null
  myClientId: string | null
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

export function _canToggleE2ee(callState: CallState, isReconnecting: boolean): boolean {
  return callState === 'active' && !isReconnecting
}

export function useVoiceCall({
  sendSignal,
  onSignalRef,
  peerConnected,
  mediaKeyRaw,
  myClientId,
}: UseVoiceCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [callDuration, setCallDuration] = useState(0)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null)
  const [isVideoEnabled, setIsVideoEnabled] = useState(false)
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null)
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null)
  const [isDeafened, setIsDeafened] = useState(false)
  const [isE2eeEnabled, setIsE2eeEnabled] = useState(VOICE_E2EE_ENABLED)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [e2eeDowngradeRequested, setE2eeDowngradeRequested] = useState(false)
  const [e2eeDowngradeIncoming, setE2eeDowngradeIncoming] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

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
  const mediaWorkersRef = useRef<Array<{ worker: Worker; cleanup: () => void }>>([])
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenSenderRef = useRef<RTCRtpSender | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const peerVideoActiveRef = useRef(false)
  const mediaKeyRawRef = useRef<Uint8Array | null>(mediaKeyRaw)
  const e2eeEnabledRef = useRef(VOICE_E2EE_ENABLED)
  const reconnectingRef = useRef(false)
  const e2eeDowngradeRequestedRef = useRef(false)

  stateRef.current = callState
  mediaKeyRawRef.current = mediaKeyRaw

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

  const terminateMediaWorkers = useCallback(() => {
    for (const entry of mediaWorkersRef.current) {
      entry.cleanup()
    }
    mediaWorkersRef.current = []
  }, [])

  const cleanupScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop())
      screenStreamRef.current = null
    }
    screenSenderRef.current = null
    setIsScreenSharing(false)
    setRemoteScreenStream(null)
  }, [])

  const cleanupVideo = useCallback(() => {
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(t => t.stop())
      videoStreamRef.current = null
    }
    videoSenderRef.current = null
    peerVideoActiveRef.current = false
    setIsVideoEnabled(false)
    setLocalVideoStream(null)
    setRemoteVideoStream(null)
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
    cleanupScreenShare()
    cleanupVideo()
    terminateMediaWorkers()
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
    setIsDeafened(false)
    setCallDuration(0)
    setLocalStream(null)
    setRemoteStream(null)
    callStartRef.current = 0
    e2eeEnabledRef.current = VOICE_E2EE_ENABLED
    setIsE2eeEnabled(VOICE_E2EE_ENABLED)
    reconnectingRef.current = false
    setIsReconnecting(false)
    e2eeDowngradeRequestedRef.current = false
    setE2eeDowngradeRequested(false)
    setE2eeDowngradeIncoming(false)
    setCallState('failed')
  }, [sendSignal, clearConnectingTimeout, clearDisconnectedTimeout, cleanupScreenShare, cleanupVideo, terminateMediaWorkers])

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
    cleanupScreenShare()
    cleanupVideo()
    terminateMediaWorkers()
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
    setIsDeafened(false)
    setCallDuration(0)
    setLocalStream(null)
    setRemoteStream(null)
    callStartRef.current = 0
    e2eeEnabledRef.current = VOICE_E2EE_ENABLED
    setIsE2eeEnabled(VOICE_E2EE_ENABLED)
    reconnectingRef.current = false
    setIsReconnecting(false)
    e2eeDowngradeRequestedRef.current = false
    setE2eeDowngradeRequested(false)
    setE2eeDowngradeIncoming(false)
  }, [clearConnectingTimeout, clearDisconnectedTimeout, cleanupScreenShare, cleanupVideo, terminateMediaWorkers])

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

  const attachTransform = useCallback((
    target: RTCRtpSender | RTCRtpReceiver,
    direction: 'encrypt' | 'decrypt',
  ): void => {
    if (!e2eeEnabledRef.current) return
    if (!('createEncodedStreams' in target)) return

    const { readable, writable } = target.createEncodedStreams()
    const { worker, cleanup } = createMediaCryptoWorker()

    const key = mediaKeyRawRef.current
    if (key) {
      const keyForMessage = buf(key)
      worker.postMessage({ type: 'set-key', key: keyForMessage }, [keyForMessage])
    }

    worker.postMessage(
      { type: 'start-transform', direction, readable, writable },
      [readable, writable],
    )

    mediaWorkersRef.current.push({ worker, cleanup })
  }, [])

  const addTrackWithTransform = useCallback((
    pc: RTCPeerConnection,
    track: MediaStreamTrack,
    stream: MediaStream,
  ): RTCRtpSender => {
    const sender = pc.addTrack(track, stream)
    attachTransform(sender, 'encrypt')

    if (track.kind === 'audio') {
      const transceiver = pc.getTransceivers().find(t => t.sender === sender)
      if (transceiver && typeof transceiver.setCodecPreferences === 'function') {
        const capabilities = RTCRtpReceiver.getCapabilities('audio')
        if (capabilities) {
          const opusCodecs = capabilities.codecs.filter(
            c => c.mimeType.toLowerCase() === 'audio/opus',
          )
          if (opusCodecs.length > 0) {
            transceiver.setCodecPreferences(opusCodecs)
          }
        }
      }
    }

    if (track.kind === 'video') {
      const transceiver = pc.getTransceivers().find(t => t.sender === sender)
      if (transceiver && typeof transceiver.setCodecPreferences === 'function') {
        const capabilities = RTCRtpReceiver.getCapabilities('video')
        if (capabilities) {
          const vp8Codecs = capabilities.codecs.filter(
            c => c.mimeType.toLowerCase() === 'video/vp8',
          )
          const otherCodecs = capabilities.codecs.filter(
            c => c.mimeType.toLowerCase() !== 'video/vp8',
          )
          if (vp8Codecs.length > 0) {
            transceiver.setCodecPreferences([...vp8Codecs, ...otherCodecs])
          }
        }
      }
    }

    return sender
  }, [attachTransform])

  const createPeerConnection = useCallback(() => {
    const config: RTCConfiguration = { iceServers: ICE_SERVERS }
    if (e2eeEnabledRef.current) {
      config.encodedInsertableStreams = true
    }
    const pc = new RTCPeerConnection(config)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          kind: 'ice-candidate',
          candidate: JSON.stringify(event.candidate.toJSON()),
        })
      }
    }

    pc.ontrack = (event) => {
      attachTransform(event.receiver, 'decrypt')

      if (event.track.kind === 'video') {
        const stream = event.streams[0] ?? new MediaStream([event.track])
        if (peerVideoActiveRef.current) {
          setRemoteVideoStream(stream)
          event.track.onended = () => {
            setRemoteVideoStream(null)
          }
        } else {
          setRemoteScreenStream(stream)
          event.track.onended = () => {
            setRemoteScreenStream(null)
          }
        }
        return
      }

      // Audio track
      if (!remoteAudioRef.current) {
        remoteAudioRef.current = new Audio()
        remoteAudioRef.current.autoplay = true
      }
      const audioStream = event.streams[0] ?? new MediaStream([event.track])
      remoteAudioRef.current.srcObject = audioStream
      setRemoteStream(audioStream)
    }

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState
      if (iceState === 'connected' || iceState === 'completed') {
        clearDisconnectedTimeout()
        if (reconnectingRef.current) {
          reconnectingRef.current = false
          setIsReconnecting(false)
        }
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
    attachTransform,
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
    setLocalStream(stream)
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

  const startCall = useCallback((targetPeerId?: string) => {
    if (stateRef.current !== 'idle') return
    sendSignal({ kind: 'voice-request', targetPeerId })
    setCallState('requesting')
  }, [sendSignal])

  const acceptCall = useCallback(async () => {
    if (stateRef.current !== 'ringing') return
    try {
      setCallState('connecting')
      sendSignal({ kind: 'voice-accept' })
      const stream = await acquireMedia()
      const pc = createPeerConnection()
      stream.getTracks().forEach(t => addTrackWithTransform(pc, t, stream))
      const pendingOffer = pendingOfferRef.current
      if (pendingOffer) {
        pendingOfferRef.current = null
        await applyOffer(pc, pendingOffer)
      }
    } catch {
      cleanupCall()
      setCallState('failed')
    }
  }, [acquireMedia, applyOffer, createPeerConnection, addTrackWithTransform, sendSignal, cleanupCall])

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

  const toggleDeafen = useCallback(() => {
    if (!remoteAudioRef.current) return
    remoteAudioRef.current.muted = !remoteAudioRef.current.muted
    setIsDeafened(remoteAudioRef.current.muted)
  }, [])

  const softReconnect = useCallback(async (newE2ee: boolean, isToggler: boolean) => {
    if (reconnectingRef.current) return
    reconnectingRef.current = true
    setIsReconnecting(true)

    // Stop screen share if active
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop())
      screenStreamRef.current = null
      screenSenderRef.current = null
      setIsScreenSharing(false)
    }

    // Stop video if active
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(t => t.stop())
      videoStreamRef.current = null
      videoSenderRef.current = null
      setIsVideoEnabled(false)
      setLocalVideoStream(null)
    }

    // Terminate media workers
    terminateMediaWorkers()

    // Close old PC
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }

    // Clear ICE buffers + pending SDP
    prePcIceCandidatesRef.current = []
    preRemoteDescIceCandidatesRef.current = []
    pendingOfferRef.current = null
    pendingAnswerRef.current = null

    // Update e2ee ref
    e2eeEnabledRef.current = newE2ee
    setIsE2eeEnabled(newE2ee)

    // Create new PC (reads new e2ee ref)
    const pc = createPeerConnection()

    // Re-add tracks from existing local stream (mic stays open)
    const stream = localStreamRef.current
    if (stream) {
      stream.getTracks().forEach(t => addTrackWithTransform(pc, t, stream))
    }

    // If toggler: create offer. If receiver: wait for incoming offer
    if (isToggler) {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
      } catch {
        // non-fatal — peer's offer will arrive
      }
    }
  }, [terminateMediaWorkers, createPeerConnection, addTrackWithTransform, sendSignal])

  const toggleE2ee = useCallback(() => {
    if (!_canToggleE2ee(stateRef.current, reconnectingRef.current)) return
    const newE2ee = !e2eeEnabledRef.current
    if (newE2ee) {
      // Upgrade: immediate, no consent needed
      sendSignal({ kind: 'e2ee-toggle', e2ee: true })
      void softReconnect(true, true)
    } else {
      // Downgrade: request consent from peer
      sendSignal({ kind: 'e2ee-downgrade-request' })
      e2eeDowngradeRequestedRef.current = true
      setE2eeDowngradeRequested(true)
    }
  }, [sendSignal, softReconnect])

  const acceptE2eeDowngrade = useCallback(() => {
    setE2eeDowngradeIncoming(false)
    sendSignal({ kind: 'e2ee-downgrade-accept' })
    void softReconnect(false, false)
  }, [sendSignal, softReconnect])

  const declineE2eeDowngrade = useCallback(() => {
    setE2eeDowngradeIncoming(false)
    sendSignal({ kind: 'e2ee-downgrade-decline' })
  }, [sendSignal])

  const acknowledgePrivacy = useCallback(() => {
    setPrivacyAcknowledged(true)
  }, [])

  const resetCallState = useCallback(() => {
    if (stateRef.current === 'ended' || stateRef.current === 'failed') {
      setCallState('idle')
    }
  }, [])

  const stopScreenShare = useCallback(() => {
    const pc = pcRef.current
    const sender = screenSenderRef.current
    if (pc && sender) {
      pc.removeTrack(sender)
      // Renegotiate SDP after track removal
      void (async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
        } catch {
          // non-fatal
        }
      })()
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop())
      screenStreamRef.current = null
    }
    screenSenderRef.current = null
    setIsScreenSharing(false)
    sendSignal({ kind: 'screen-share-stop' })
  }, [sendSignal])

  const startScreenShare = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || stateRef.current !== 'active') return
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 5, max: 15 },
        },
        audio: false,
      })
      screenStreamRef.current = stream
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      videoTrack.contentHint = 'detail'
      videoTrack.onended = () => {
        stopScreenShare()
      }
      const sender = addTrackWithTransform(pc, videoTrack, stream)
      screenSenderRef.current = sender
      try {
        const params = sender.getParameters()
        if (!params.encodings) params.encodings = [{}]
        const encoding = params.encodings[0]
        if (encoding) {
          encoding.maxBitrate = 2_500_000
          encoding.maxFramerate = 15
        }
        await sender.setParameters(params)
      } catch { /* non-fatal */ }
      // Renegotiate SDP after adding track
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
      setIsScreenSharing(true)
      sendSignal({ kind: 'screen-share-start' })
    } catch {
      // User cancelled or error — clean up
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop())
        screenStreamRef.current = null
      }
    }
  }, [addTrackWithTransform, sendSignal, stopScreenShare])

  const stopVideo = useCallback(() => {
    const pc = pcRef.current
    const sender = videoSenderRef.current
    if (pc && sender) {
      pc.removeTrack(sender)
      void (async () => {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
        } catch {
          // non-fatal
        }
      })()
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(t => t.stop())
      videoStreamRef.current = null
    }
    videoSenderRef.current = null
    setIsVideoEnabled(false)
    setLocalVideoStream(null)
    sendSignal({ kind: 'video-stop' })
  }, [sendSignal])

  const startVideo = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || stateRef.current !== 'active') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      })
      videoStreamRef.current = stream
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      videoTrack.onended = () => {
        stopVideo()
      }
      const sender = addTrackWithTransform(pc, videoTrack, stream)
      videoSenderRef.current = sender
      try {
        const params = sender.getParameters()
        if (!params.encodings) params.encodings = [{}]
        const encoding = params.encodings[0]
        if (encoding) {
          encoding.maxBitrate = 1_500_000
          encoding.maxFramerate = 30
        }
        await sender.setParameters(params)
      } catch { /* non-fatal */ }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendSignal({ kind: 'sdp-offer', sdp: JSON.stringify(offer) })
      setIsVideoEnabled(true)
      setLocalVideoStream(stream)
      sendSignal({ kind: 'video-start' })
    } catch {
      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach(t => t.stop())
        videoStreamRef.current = null
      }
    }
  }, [addTrackWithTransform, sendSignal, stopVideo])

  const handleSignal = useCallback(async (signal: VoiceSignal, _senderId: string) => {
    switch (signal.kind) {
      case 'voice-request': {
        // If the call targets a specific peer, ignore if it's not us
        if (signal.targetPeerId && signal.targetPeerId !== myClientId) break
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
          stream.getTracks().forEach(t => addTrackWithTransform(pc, t, stream))
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
        if (stateRef.current !== 'connecting' && stateRef.current !== 'active') break
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
        if (stateRef.current !== 'connecting' && stateRef.current !== 'active') break
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

      case 'screen-share-start': {
        // Informational — the actual track arrives via ontrack
        break
      }

      case 'screen-share-stop': {
        setRemoteScreenStream(null)
        break
      }

      case 'video-start': {
        peerVideoActiveRef.current = true
        break
      }

      case 'video-stop': {
        peerVideoActiveRef.current = false
        setRemoteVideoStream(null)
        break
      }

      case 'e2ee-toggle': {
        if (!signal.e2ee) break // reject legacy downgrade signals
        if (!_canToggleE2ee(stateRef.current, reconnectingRef.current)) break
        void softReconnect(signal.e2ee, false)
        break
      }

      case 'e2ee-downgrade-request': {
        // Simultaneous request: both sides want to downgrade → mutual accept
        if (e2eeDowngradeRequestedRef.current) {
          e2eeDowngradeRequestedRef.current = false
          setE2eeDowngradeRequested(false)
          sendSignal({ kind: 'e2ee-downgrade-accept' })
          void softReconnect(false, false)
          break
        }
        if (!_canToggleE2ee(stateRef.current, reconnectingRef.current) || !e2eeEnabledRef.current) {
          sendSignal({ kind: 'e2ee-downgrade-decline' })
          break
        }
        setE2eeDowngradeIncoming(true)
        break
      }

      case 'e2ee-downgrade-accept': {
        if (!e2eeDowngradeRequestedRef.current) break
        e2eeDowngradeRequestedRef.current = false
        setE2eeDowngradeRequested(false)
        void softReconnect(false, true)
        break
      }

      case 'e2ee-downgrade-decline': {
        e2eeDowngradeRequestedRef.current = false
        setE2eeDowngradeRequested(false)
        break
      }
    }
  }, [
    acquireMedia,
    addIceCandidateSafe,
    addTrackWithTransform,
    applyAnswer,
    applyOffer,
    createPeerConnection,
    sendSignal,
    cleanupCall,
    softReconnect,
    myClientId,
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
    isScreenSharing,
    remoteScreenStream,
    isDeafened,
    isE2eeEnabled,
    isReconnecting,
    localStream,
    remoteStream,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    toggleDeafen,
    toggleE2ee,
    e2eeDowngradeRequested,
    e2eeDowngradeIncoming,
    acceptE2eeDowngrade,
    declineE2eeDowngrade,
    acknowledgePrivacy,
    resetCallState,
    startScreenShare,
    stopScreenShare,
    isVideoEnabled,
    localVideoStream,
    remoteVideoStream,
    startVideo,
    stopVideo,
  }
}
