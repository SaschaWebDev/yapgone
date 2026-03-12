import { useState, useEffect, useRef } from 'react'
import type { CallState } from '@/types'
import { Button } from '../button'
import { IconPhone, IconMic, IconMicOff, IconScreenShare, IconScreenShareOff } from '../icons'
import styles from './VoiceControls.module.css'

type PrivacyAction = 'start' | 'accept'

export function _requiresPrivacyGate(privacyAcknowledged: boolean): boolean {
  return !privacyAcknowledged
}

interface VoiceControlsProps {
  callState: CallState
  isMuted: boolean
  callDuration: number
  privacyAcknowledged: boolean
  isScreenSharing: boolean
  onStartCall: () => void
  onAcceptCall: () => void
  onDeclineCall: () => void
  onEndCall: () => void
  onToggleMute: () => void
  onAcknowledgePrivacy: () => void
  onResetCallState: () => void
  onStartScreenShare: () => void
  onStopScreenShare: () => void
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function VoiceControls({
  callState,
  isMuted,
  callDuration,
  privacyAcknowledged,
  isScreenSharing,
  onStartCall,
  onAcceptCall,
  onDeclineCall,
  onEndCall,
  onToggleMute,
  onAcknowledgePrivacy,
  onResetCallState,
  onStartScreenShare,
  onStopScreenShare,
}: VoiceControlsProps) {
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false)
  const [pendingPrivacyAction, setPendingPrivacyAction] = useState<PrivacyAction | null>(null)
  const [ringtoneBlocked, setRingtoneBlocked] = useState(false)
  const ringtoneRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const ringtone = new Audio('/yapgone-ringtone.mp3')
    ringtone.loop = true
    ringtone.preload = 'auto'
    ringtoneRef.current = ringtone

    return () => {
      if (ringtoneRef.current) {
        ringtoneRef.current.pause()
        ringtoneRef.current.currentTime = 0
      }
      ringtoneRef.current = null
    }
  }, [])

  useEffect(() => {
    const ringtone = ringtoneRef.current
    if (!ringtone) return

    if (callState === 'ringing') {
      ringtone.currentTime = 0
      void ringtone.play()
        .then(() => {
          setRingtoneBlocked(false)
        })
        .catch(() => {
          // Browser may block autoplay until user interaction.
          setRingtoneBlocked(true)
        })
      return
    }

    ringtone.pause()
    ringtone.currentTime = 0
    setRingtoneBlocked(false)
  }, [callState])

  const handleEnableRingtone = () => {
    const ringtone = ringtoneRef.current
    if (!ringtone) return
    ringtone.currentTime = 0
    void ringtone.play()
      .then(() => {
        setRingtoneBlocked(false)
      })
      .catch(() => {
        setRingtoneBlocked(true)
      })
  }

  // Auto-reset ended/failed state after a brief display
  useEffect(() => {
    if (callState === 'ended' || callState === 'failed') {
      const timer = setTimeout(onResetCallState, 3000)
      return () => clearTimeout(timer)
    }
  }, [callState, onResetCallState])

  const runPrivacyAction = (action: PrivacyAction) => {
    if (action === 'start') {
      onStartCall()
      return
    }
    onAcceptCall()
  }

  const handleStartCallClick = () => {
    if (_requiresPrivacyGate(privacyAcknowledged)) {
      setShowPrivacyNotice(true)
      setPendingPrivacyAction('start')
      return
    }
    onStartCall()
  }

  const handleAcceptCallClick = () => {
    if (_requiresPrivacyGate(privacyAcknowledged)) {
      setShowPrivacyNotice(true)
      setPendingPrivacyAction('accept')
      return
    }
    onAcceptCall()
  }

  const handlePrivacyAccept = () => {
    const action = pendingPrivacyAction
    setShowPrivacyNotice(false)
    setPendingPrivacyAction(null)
    onAcknowledgePrivacy()
    if (action) {
      runPrivacyAction(action)
    }
  }

  const handlePrivacyCancel = () => {
    setShowPrivacyNotice(false)
    setPendingPrivacyAction(null)
  }

  useEffect(() => {
    if (pendingPrivacyAction === 'accept' && callState !== 'ringing') {
      setShowPrivacyNotice(false)
      setPendingPrivacyAction(null)
    }
  }, [pendingPrivacyAction, callState])

  if (showPrivacyNotice) {
    return (
      <div className={styles.privacyNotice}>
        <p className={styles.privacyText}>
          Voice calls connect directly between you and your partner (peer-to-peer).
          This applies whether you start or accept a call. Your IP address will be
          visible to them. Use a VPN if this concerns you.
        </p>
        <div className={styles.privacyActions}>
          <Button intent='neutral' size='sm' onClick={handlePrivacyCancel}>
            Cancel
          </Button>
          <Button intent='positive' size='sm' onClick={handlePrivacyAccept}>
            I understand, continue
          </Button>
        </div>
      </div>
    )
  }

  if (callState === 'idle') {
    return (
      <div className={styles.wrapper}>
        <button
          className={styles.callButton}
          onClick={handleStartCallClick}
          title="Start voice call"
          aria-label="Start voice call"
        >
          <IconPhone size={21} />
          <span className={styles.callLabel}>Voice Call</span>
        </button>
      </div>
    )
  }

  if (callState === 'requesting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Calling...</span>
          <Button intent='neutral' size='sm' onClick={onEndCall}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (callState === 'ringing') {
    return (
      <div className={styles.wrapper}>
        <div className={`${styles.banner} ${styles.incomingBanner}`}>
          <span className={`${styles.bannerText} ${styles.incomingText}`}>
            Incoming voice call. Choose Accept or Decline.
          </span>
          {ringtoneBlocked && (
            <button
              className={styles.enableRingtoneButton}
              onClick={handleEnableRingtone}
              title="Enable ringtone"
              aria-label="Enable ringtone"
            >
              Enable ringtone
            </button>
          )}
          <button
            className={styles.acceptButton}
            onClick={handleAcceptCallClick}
            title="Accept call"
            aria-label="Accept call"
          >
            <IconPhone size={21} />
          </button>
          <button
            className={styles.declineButton}
            onClick={onDeclineCall}
            title="Decline call"
            aria-label="Decline call"
          >
            <IconPhone size={21} style={{ transform: 'rotate(135deg)' }} />
          </button>
        </div>
      </div>
    )
  }

  if (callState === 'connecting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Connecting...</span>
          <Button intent='neutral' size='sm' onClick={onEndCall}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (callState === 'active') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.activeDot} />
        <span className={styles.duration}>{formatDuration(callDuration)}</span>
        <div className={styles.banner} />
        <button
          className={isMuted ? styles.mutedButton : styles.muteButton}
          onClick={onToggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {isMuted ? <IconMicOff size={21} /> : <IconMic size={21} />}
        </button>
        {typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getDisplayMedia === 'function' && (
          <button
            className={isScreenSharing ? styles.screenShareActiveButton : styles.screenShareButton}
            onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
            title={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
            aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
          >
            {isScreenSharing ? <IconScreenShareOff size={21} /> : <IconScreenShare size={21} />}
          </button>
        )}
        <button
          className={styles.endCallButton}
          onClick={onEndCall}
          title="End call"
          aria-label="End call"
        >
          <IconPhone size={21} style={{ transform: 'rotate(135deg)' }} />
        </button>
      </div>
    )
  }

  if (callState === 'ended') {
    return (
      <div className={styles.wrapper}>
        <span className={styles.endedText}>Call ended</span>
      </div>
    )
  }

  if (callState === 'failed') {
    return (
      <div className={styles.wrapper}>
        <span className={styles.failedText}>Voice unavailable</span>
        <Button intent='neutral' size='sm' onClick={onResetCallState}>
          Dismiss
        </Button>
      </div>
    )
  }

  return null
}
