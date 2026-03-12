import { createPortal } from 'react-dom'
import styles from './InactivityCountdown.module.css'

interface InactivityCountdownProps {
  remainingSeconds: number
  showThresholdSeconds?: number
}

export function InactivityCountdown({
  remainingSeconds,
  showThresholdSeconds = 60,
}: InactivityCountdownProps) {
  if (remainingSeconds > showThresholdSeconds) return null

  const timerClass = remainingSeconds <= 10
    ? `${styles.timer} ${styles.timerPulse}`
    : styles.timer

  return createPortal(
    <div className={styles.overlay} aria-label={`Session expiring in ${remainingSeconds} seconds`}>
      <span className={timerClass}>{remainingSeconds}</span>
      <span className={styles.label}>Session expiring</span>
    </div>,
    document.body,
  )
}
