import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { NOTEFADE_MAX_NOTE_LENGTH } from '@/constants'
import styles from './NotefadeComposer.module.css'

interface NotefadeComposerProps {
  onSend: (text: string) => void
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

  const handleSend = useCallback(() => {
    if (!canSend) return
    onSend(text.trim())
  }, [canSend, text, onSend])

  const remaining = NOTEFADE_MAX_NOTE_LENGTH - text.length

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.heading}>Self-destructing note</h3>
        <p className={styles.description}>
          This note will be encrypted and can only be read once. After that, it fades.
        </p>
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
        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.sendButton}
            disabled={!canSend}
            onClick={handleSend}
          >
            Send
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
