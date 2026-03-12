import styles from './ReplyPreview.module.css'

interface ReplyPreviewProps {
  text: string
  displayName?: string
  onCancel: () => void
}

export function ReplyPreview({ text, displayName, onCancel }: ReplyPreviewProps) {
  return (
    <div className={styles.preview}>
      <div className={styles.bar} />
      <div className={styles.content}>
        {displayName && <span className={styles.name}>{displayName}</span>}
        <span className={styles.text}>{text}</span>
      </div>
      <button type="button" className={styles.cancel} onClick={onCancel} aria-label="Cancel reply">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
