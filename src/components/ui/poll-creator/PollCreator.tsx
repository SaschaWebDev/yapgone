import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { OnOffToggle } from '../on-off-toggle'
import { EmojiFullPicker } from '../emoji-picker'
import { POLL_MAX_OPTIONS, POLL_MAX_QUESTION_LENGTH, POLL_MAX_OPTION_LENGTH } from '@/constants'
import styles from './PollCreator.module.css'

interface PollOption {
  text: string
  emoji: string
}

type EmojiPickerTarget = { kind: 'question' } | { kind: 'option'; index: number }

interface PollCreatorProps {
  onSend: (question: string, questionEmoji: string, options: Array<{ text: string; emoji: string }>, allowMultiple: boolean) => void
  onClose: () => void
  recentEmojis?: readonly string[]
  onTrackEmoji?: (emoji: string) => void
}

export function PollCreator({ onSend, onClose, recentEmojis = [], onTrackEmoji }: PollCreatorProps) {
  const [question, setQuestion] = useState('')
  const [questionEmoji, setQuestionEmoji] = useState('\u{1F4CA}')
  const [options, setOptions] = useState<PollOption[]>([
    { text: '', emoji: '' },
    { text: '', emoji: '' },
  ])
  const [allowMultiple, setAllowMultiple] = useState(false)
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<EmojiPickerTarget | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const questionRef = useRef<HTMLInputElement>(null)
  const questionEmojiRef = useRef<HTMLButtonElement>(null)
  const optionEmojiRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  useEffect(() => {
    questionRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (emojiPickerTarget) {
          setEmojiPickerTarget(null)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, emojiPickerTarget])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const openEmojiPicker = useCallback((target: EmojiPickerTarget) => {
    const el = target.kind === 'question'
      ? questionEmojiRef.current
      : optionEmojiRefs.current.get(target.index)
    if (el) {
      setAnchorRect(el.getBoundingClientRect())
      setEmojiPickerTarget(target)
    }
  }, [])

  const handleEmojiSelect = useCallback((emoji: string) => {
    if (!emojiPickerTarget) return
    if (emojiPickerTarget.kind === 'question') {
      setQuestionEmoji(emoji)
    } else {
      const idx = emojiPickerTarget.index
      setOptions(prev => prev.map((o, i) => i === idx ? { ...o, emoji } : o))
    }
    onTrackEmoji?.(emoji)
    setEmojiPickerTarget(null)
  }, [emojiPickerTarget, onTrackEmoji])

  const updateOption = useCallback((index: number, text: string) => {
    setOptions(prev => {
      const next = prev.map((o, i) => i === index ? { ...o, text } : o)
      // Auto-add new row when typing in last non-empty option
      let lastNonEmpty = -1
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.text.trim().length > 0) { lastNonEmpty = i; break }
      }
      if (lastNonEmpty === next.length - 1 && next.length < POLL_MAX_OPTIONS) {
        next.push({ text: '', emoji: '' })
      }
      return next
    })
  }, [])

  const removeOption = useCallback((index: number) => {
    setOptions(prev => prev.length > 2 ? prev.filter((_, i) => i !== index) : prev)
  }, [])

  const nonEmptyOptions = options.filter(o => o.text.trim().length > 0)
  const canSend = question.trim().length > 0 && nonEmptyOptions.length >= 2

  const handleSend = useCallback(() => {
    if (!canSend) return
    onSend(question.trim(), questionEmoji, nonEmptyOptions, allowMultiple)
    onClose()
  }, [canSend, question, questionEmoji, nonEmptyOptions, allowMultiple, onSend, onClose])

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.heading}>Create Poll</h3>
        <div className={styles.questionRow}>
          <button
            ref={questionEmojiRef}
            type="button"
            tabIndex={-1}
            className={styles.emojiButton}
            onClick={() => openEmojiPicker({ kind: 'question' })}
          >
            {questionEmoji}
          </button>
          <input
            ref={questionRef}
            type="text"
            className={styles.input}
            value={question}
            onChange={(e) => setQuestion(e.target.value.slice(0, POLL_MAX_QUESTION_LENGTH))}
            placeholder="Ask a question..."
          />
        </div>
        <div className={styles.divider} />
        <p className={styles.optionsLabel}>Options</p>
        <div className={styles.optionsList}>
          {options.map((opt, i) => (
            <div key={i} className={styles.optionRow}>
              <button
                ref={(el) => { if (el) optionEmojiRefs.current.set(i, el); else optionEmojiRefs.current.delete(i) }}
                type="button"
                tabIndex={-1}
                className={styles.optionEmoji}
                onClick={() => openEmojiPicker({ kind: 'option', index: i })}
              >
                {opt.emoji || `${i + 1}`}
              </button>
              <input
                type="text"
                className={styles.optionInput}
                value={opt.text}
                onChange={(e) => updateOption(i, e.target.value.slice(0, POLL_MAX_OPTION_LENGTH))}
                placeholder={`Option ${i + 1}`}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  tabIndex={-1}
                  className={styles.removeButton}
                  onClick={() => removeOption(i)}
                  aria-label={`Remove option ${i + 1}`}
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
        <div className={styles.toggleRow}>
          <span>Allow multiple answers</span>
          <OnOffToggle
            enabled={allowMultiple}
            onToggle={() => setAllowMultiple(prev => !prev)}
          />
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
      {emojiPickerTarget && anchorRect && (
        <EmojiFullPicker
          onSelect={handleEmojiSelect}
          onClose={() => setEmojiPickerTarget(null)}
          recentEmojis={recentEmojis}
          anchorRect={anchorRect}
        />
      )}
    </div>,
    document.body,
  )
}
