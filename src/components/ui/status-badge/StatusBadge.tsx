import type { ChatPhase } from '@/hooks/use-chat'
import styles from './StatusBadge.module.css'

interface StatusBadgeProps {
  phase: ChatPhase
}

const PHASE_LABELS: Record<ChatPhase, string> = {
  creating: 'Setting up...',
  waiting: 'Waiting for partner',
  connecting: 'Connecting...',
  'key-exchange': 'Establishing encryption...',
  ready: 'Encrypted',
  'peer-left': 'Disconnected',
  'room-closed': 'Ended',
  expired: 'Expired',
  error: 'Error',
}

export function StatusBadge({ phase }: StatusBadgeProps) {
  const isActive = phase === 'ready'
  const isWarning = phase === 'peer-left' || phase === 'room-closed' || phase === 'expired' || phase === 'error'

  return (
    <div className={styles.badge} aria-label={`Status: ${PHASE_LABELS[phase]}`}>
      <span
        className={`${styles.dot} ${isActive ? styles.active : ''} ${isWarning ? styles.warning : ''}`}
      />
      <span className={styles.label}>{PHASE_LABELS[phase]}</span>
    </div>
  )
}
