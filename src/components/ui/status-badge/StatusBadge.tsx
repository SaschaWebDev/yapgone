import type { ChatPhase } from '@/hooks/use-chat'
import styles from './StatusBadge.module.css'

export type ConnectionQuality = 'good' | 'degraded' | 'reconnecting' | 'lost'

interface StatusBadgeProps {
  phase: ChatPhase
  connectionQuality?: ConnectionQuality
}

const PHASE_LABELS: Record<ChatPhase, string> = {
  creating: 'Setting up...',
  waiting: 'Waiting for partner',
  connecting: 'Connecting...',
  'key-exchange': 'Establishing encryption...',
  ready: 'Encrypted',
  'peer-left': 'Disconnected',
  'peer-disconnected': 'Partner disconnected',
  'room-closed': 'Ended',
  expired: 'Expired',
  error: 'Error',
}

const QUALITY_LABELS: Record<Exclude<ConnectionQuality, 'good'>, string> = {
  degraded: 'Connection degraded',
  reconnecting: 'Reconnecting...',
  lost: 'Connection lost',
}

function SignalBars({ quality }: { quality: Exclude<ConnectionQuality, 'good'> }) {
  const bars = quality === 'reconnecting' ? 2 : quality === 'degraded' ? 1 : 0
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="11" width="3" height="4" rx="0.5" opacity={bars >= 0 ? 1 : 0.25} />
      <rect x="6" y="7" width="3" height="8" rx="0.5" opacity={bars >= 1 ? 1 : 0.25} />
      <rect x="11" y="3" width="3" height="12" rx="0.5" opacity={bars >= 2 ? 1 : 0.25} />
    </svg>
  )
}

export function StatusBadge({ phase, connectionQuality }: StatusBadgeProps) {
  const isActive = phase === 'ready'
  const isWarning = phase === 'peer-left' || phase === 'peer-disconnected' || phase === 'room-closed' || phase === 'expired' || phase === 'error'

  return (
    <div className={styles.badge} aria-label={`Status: ${PHASE_LABELS[phase]}`}>
      <span
        className={`${styles.dot} ${isActive ? styles.active : ''} ${isWarning ? styles.warning : ''}`}
      />
      <span className={styles.label}>{PHASE_LABELS[phase]}</span>
      {connectionQuality && connectionQuality !== 'good' && (
        <span
          className={`${styles.quality} ${styles[connectionQuality]}`}
          title={QUALITY_LABELS[connectionQuality]}
        >
          <SignalBars quality={connectionQuality} />
        </span>
      )}
    </div>
  )
}
