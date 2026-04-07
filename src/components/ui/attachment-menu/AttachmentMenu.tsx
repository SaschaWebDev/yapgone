import { useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { IconFile, IconPoll, IconPrediction, IconImage, IconCamera, IconNotefade, IconEmoji } from '../icons'
import styles from './AttachmentMenu.module.css'

interface AttachmentMenuProps {
  anchorRect: DOMRect
  onFileSelect: () => void
  onPhotoSelect?: () => void
  onCameraCapture?: () => void
  onPollCreate?: () => void
  onPredictionCreate?: () => void
  onNotefadeCreate?: () => void
  onEmojiSelect?: () => void
  onClose: () => void
}

export function AttachmentMenu({ anchorRect, onFileSelect, onPhotoSelect, onCameraCapture, onPollCreate, onPredictionCreate, onNotefadeCreate, onEmojiSelect, onClose }: AttachmentMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [handleClickOutside])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const itemCount = 1 + (onPhotoSelect ? 1 : 0) + (onCameraCapture ? 1 : 0) + (onPollCreate ? 1 : 0) + (onPredictionCreate ? 1 : 0) + (onNotefadeCreate ? 1 : 0) + (onEmojiSelect ? 1 : 0)
  const estimatedHeight = itemCount * (2.65 * rem) + 0.7 * rem
  const spaceAbove = anchorRect.top - 8
  const placeAbove = spaceAbove >= estimatedHeight

  const posStyle: React.CSSProperties = { left: anchorRect.left }

  if (placeAbove) {
    posStyle.bottom = window.innerHeight - anchorRect.top + 4
  } else {
    posStyle.top = anchorRect.bottom + 4
  }

  return createPortal(
    <div className={styles.overlay}>
      <div
        ref={ref}
        className={styles.menu}
        style={{ position: 'fixed', ...posStyle }}
      >
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => { onFileSelect(); onClose() }}
        >
          <span className={styles.menuItemIcon}><IconFile size={18} /></span>
          File
        </button>
        {onPhotoSelect && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onPhotoSelect(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconImage size={18} /></span>
            Photo
          </button>
        )}
        {onCameraCapture && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onCameraCapture(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconCamera size={18} /></span>
            Camera
          </button>
        )}
        {onPollCreate && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onPollCreate(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconPoll size={18} /></span>
            Poll
          </button>
        )}
        {onPredictionCreate && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onPredictionCreate(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconPrediction size={18} /></span>
            Prediction
          </button>
        )}
        {onNotefadeCreate && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onNotefadeCreate(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconNotefade size={18} /></span>
            Self-destructing note
          </button>
        )}
        {onEmojiSelect && (
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => { onEmojiSelect(); onClose() }}
          >
            <span className={styles.menuItemIcon}><IconEmoji size={18} /></span>
            Emoji
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
