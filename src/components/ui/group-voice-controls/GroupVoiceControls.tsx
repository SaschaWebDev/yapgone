import { IconMic, IconMicOff, IconPhone } from '../icons'
import styles from './GroupVoiceControls.module.css'

interface GroupVoiceControlsProps {
  isInGroupVoice: boolean
  isMuted: boolean
  voiceParticipants: Set<string>
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
}

export function GroupVoiceControls({
  isInGroupVoice,
  isMuted,
  voiceParticipants,
  onJoin,
  onLeave,
  onToggleMute,
}: GroupVoiceControlsProps) {
  const participantCount = voiceParticipants.size + (isInGroupVoice ? 1 : 0)

  if (!isInGroupVoice && participantCount === 0) {
    return (
      <div className={styles.wrapper}>
        <span className={styles.label}>Group voice</span>
        <button
          className={styles.joinButton}
          onClick={onJoin}
          title="Join group voice"
          aria-label="Join group voice"
        >
          <IconPhone size={16} />
        </button>
      </div>
    )
  }

  if (!isInGroupVoice) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.activeDot} />
        <span className={styles.label}>
          Voice active
        </span>
        <span className={styles.participantCount}>
          {participantCount} in call
        </span>
        <button
          className={styles.joinButton}
          onClick={onJoin}
          title="Join group voice"
          aria-label="Join group voice"
        >
          <IconPhone size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.activeDot} />
      <span className={styles.label}>
        In voice
      </span>
      <span className={styles.participantCount}>
        {participantCount} in call
      </span>
      <button
        className={isMuted ? styles.mutedButton : styles.muteButton}
        onClick={onToggleMute}
        title={isMuted ? 'Unmute' : 'Mute'}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {isMuted ? <IconMicOff size={16} /> : <IconMic size={16} />}
      </button>
      <button
        className={styles.leaveButton}
        onClick={onLeave}
        title="Leave voice"
        aria-label="Leave group voice"
      >
        <IconPhone size={16} style={{ transform: 'rotate(135deg)' }} />
      </button>
    </div>
  )
}
