import styles from './InactivityCountdown.module.css'

interface InactivityCountdownProps {
  remainingSeconds: number
  warningThresholdSeconds: number
  urgentThresholdSeconds: number
}

export function InactivityCountdown({
  remainingSeconds,
  warningThresholdSeconds,
  urgentThresholdSeconds,
}: InactivityCountdownProps) {
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const display = `${minutes}:${String(seconds).padStart(2, '0')}`

  let className = styles.countdown
  if (remainingSeconds <= urgentThresholdSeconds) {
    className += ` ${styles.urgent}`
  } else if (remainingSeconds <= warningThresholdSeconds) {
    className += ` ${styles.warning}`
  }

  return (
    <span className={className} aria-label={`Room expires in ${display}`}>
      {display}
    </span>
  )
}
