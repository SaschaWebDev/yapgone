import { useState, useEffect } from 'react'
import type { CallState } from '@/types'
import { IconPhone, IconMic, IconMicOff } from '../icons'
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
  onStartCall: () => void
  onAcceptCall: () => void
  onDeclineCall: () => void
  onEndCall: () => void
  onToggleMute: () => void
  onAcknowledgePrivacy: () => void
  onResetCallState: () => void
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
  onStartCall,
  onAcceptCall,
  onDeclineCall,
  onEndCall,
  onToggleMute,
  onAcknowledgePrivacy,
  onResetCallState,
}: VoiceControlsProps) {
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false)
  const [pendingPrivacyAction, setPendingPrivacyAction] = useState<PrivacyAction | null>(null)

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
          <button
            className={styles.privacyCancel}
            onClick={handlePrivacyCancel}
          >
            Cancel
          </button>
          <button
            className={styles.privacyAccept}
            onClick={handlePrivacyAccept}
          >
            I understand, continue
          </button>
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
          <IconPhone size={14} />
        </button>
      </div>
    )
  }

  if (callState === 'requesting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Calling...</span>
          <button className={styles.cancelButton} onClick={onEndCall}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (callState === 'ringing') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Incoming voice call</span>
          <button
            className={styles.acceptButton}
            onClick={handleAcceptCallClick}
            title="Accept call"
            aria-label="Accept call"
          >
            <IconPhone size={14} />
          </button>
          <button
            className={styles.declineButton}
            onClick={onDeclineCall}
            title="Decline call"
            aria-label="Decline call"
          >
            <IconPhone size={14} style={{ transform: 'rotate(135deg)' }} />
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
          <button className={styles.cancelButton} onClick={onEndCall}>
            Cancel
          </button>
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
          {isMuted ? <IconMicOff size={14} /> : <IconMic size={14} />}
        </button>
        <button
          className={styles.endCallButton}
          onClick={onEndCall}
          title="End call"
          aria-label="End call"
        >
          <IconPhone size={14} style={{ transform: 'rotate(135deg)' }} />
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
        <button className={styles.retryButton} onClick={onResetCallState}>
          Dismiss
        </button>
      </div>
    )
  }

  return null
}
