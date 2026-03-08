import styles from './MessageBubble.module.css'

interface MessageBubbleProps {
  text: string
  sender: 'self' | 'peer' | 'system'
  timestamp: number
}

export function MessageBubble({ text, sender, timestamp }: MessageBubbleProps) {
  if (sender === 'system') {
    return (
      <div className={styles.system} role="listitem">
        <p className={styles.systemText}>{text}</p>
      </div>
    )
  }

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      className={`${styles.bubble} ${sender === 'self' ? styles.self : styles.peer}`}
      role="listitem"
    >
      <p className={styles.text}>{text}</p>
      <time className={styles.time} dateTime={new Date(timestamp).toISOString()}>
        {time}
      </time>
    </div>
  )
}
