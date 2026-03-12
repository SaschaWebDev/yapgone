import { useRef, useEffect, useCallback } from 'react'
import styles from './EmojiQuickPick.module.css'

const EMOJI_SET = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F525}']

interface EmojiQuickPickProps {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export function EmojiQuickPick({ onSelect, onClose }: EmojiQuickPickProps) {
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

  return (
    <div ref={ref} className={styles.picker}>
      {EMOJI_SET.map(emoji => (
        <button
          key={emoji}
          type="button"
          className={styles.emojiButton}
          onClick={() => onSelect(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
