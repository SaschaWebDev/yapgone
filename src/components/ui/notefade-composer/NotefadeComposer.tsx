import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { NOTEFADE_MAX_NOTE_LENGTH } from '@/constants'
import styles from './NotefadeComposer.module.css'

interface NotefadeComposerProps {
  onSend: (text: string, mode: 'url' | 'chat') => void
  onClose: () => void
}

export function NotefadeComposer({ onSend, onClose }: NotefadeComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const canSend = text.trim().length > 0

  const handleSendUrl = useCallback(() => {
    if (!canSend) return
    onSend(text.trim(), 'url')
  }, [canSend, text, onSend])

  const handleSendChat = useCallback(() => {
    if (!canSend) return
    onSend(text.trim(), 'chat')
  }, [canSend, text, onSend])

  const remaining = NOTEFADE_MAX_NOTE_LENGTH - text.length

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.heading}>Self-destructing note</h3>
        <p className={styles.description}>
          This note will be encrypted and can only be read once. After that, it fades.
        </p>
        <div className={styles.textareaWrap}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, NOTEFADE_MAX_NOTE_LENGTH))}
            placeholder="Write something secret..."
            rows={5}
          />
          <div className={styles.charCount} data-warn={remaining <= 100 ? '' : undefined}>
            {remaining}
          </div>
        </div>
        <div className={styles.helpText}>
          <p><strong>Chat</strong> — delivers the note inline. You'll see when it's read, and can destroy it yourself.</p>
          <p><strong>URL</strong> — creates a link the reader can open anytime, even outside this chat.</p>
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
          <div className={styles.sendGroup}>
            <span className={styles.sendLabel}>Send via</span>
            <div className={styles.splitButton}>
              <button
                type="button"
                className={styles.splitButtonLeft}
                disabled={!canSend}
                onClick={handleSendChat}
              >
                Chat
              </button>
              <div className={styles.splitDivider} />
              <button
                type="button"
                className={styles.splitButtonRight}
                disabled={!canSend}
                onClick={handleSendUrl}
              >
                URL
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
