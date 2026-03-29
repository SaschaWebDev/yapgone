import { useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_QUICK_EMOJIS } from '@/data/emoji-data'
import styles from './EmojiQuickPick.module.css'

interface EmojiQuickPickProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  onExpand: () => void
  recentEmojis: readonly string[]
  anchorRect: DOMRect
  alignRight?: boolean
}

export function EmojiQuickPick({ onSelect, onClose, onExpand, recentEmojis, anchorRect, alignRight }: EmojiQuickPickProps) {
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

  const displayEmojis = recentEmojis.length > 0
    ? [...recentEmojis, ...DEFAULT_QUICK_EMOJIS.filter(e => !recentEmojis.includes(e))].slice(0, 6)
    : [...DEFAULT_QUICK_EMOJIS]

  // Position above anchor by default, flip below if near viewport top
  const pickerHeight = 44 // approx picker height
  const spaceAbove = anchorRect.top - 8
  const placeAbove = spaceAbove >= pickerHeight

  const top = placeAbove
    ? anchorRect.top - pickerHeight - 4
    : anchorRect.bottom + 4

  // Clamp horizontally within viewport (7 × 32px buttons + rem gaps/padding ≈ 274px)
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const pickerW = 7 * 32 + 6 * 0.15 * rem + 2 * 0.4 * rem + 0.35 * rem + 1
  const idealLeft = alignRight ? anchorRect.right - pickerW : anchorRect.left
  const left = Math.max(8, Math.min(idealLeft, window.innerWidth - pickerW - 8))

  return createPortal(
    <div
      ref={ref}
      className={styles.picker}
      style={{
        position: 'fixed',
        top,
        left,
      }}
    >
      {displayEmojis.map(emoji => (
        <button
          key={emoji}
          type="button"
          className={styles.emojiButton}
          onClick={() => onSelect(emoji)}
        >
          {emoji}
        </button>
      ))}
      <button
        type="button"
        className={styles.expandButton}
        onClick={onExpand}
        aria-label="More emojis"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>,
    document.body
  )
}
