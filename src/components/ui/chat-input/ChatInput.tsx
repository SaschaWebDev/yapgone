import { useState, useRef, useCallback, useEffect } from 'react'
import { IconMic } from '../icons'
import styles from './ChatInput.module.css'

interface ChatInputProps {
  onSend: (text: string) => void
  onTyping: (active: boolean) => void
  disabled: boolean
  maxLength: number
  focusTrigger?: number
  isRecording?: boolean
  isSendingVoiceNote?: boolean
  recordingDuration?: number
  onStartRecording?: () => void
  onStopRecording?: () => void
  onCancelRecording?: () => void
  voiceNoteError?: string | null
  voiceNoteSizeWarningSeconds?: number | null
}

const TYPING_TIMEOUT = 5_000

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ChatInput({
  onSend,
  onTyping,
  disabled,
  maxLength,
  focusTrigger,
  isRecording = false,
  isSendingVoiceNote = false,
  recordingDuration = 0,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  voiceNoteError,
  voiceNoteSizeWarningSeconds,
}: ChatInputProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isTypingRef = useRef(false)
  const textRef = useRef('')
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canAutoFocus = !disabled && !isRecording

  useEffect(() => {
    if (canAutoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [canAutoFocus])

  useEffect(() => {
    if (focusTrigger && canAutoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [focusTrigger, canAutoFocus])

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
    }
  }, [])

  const wrapSelection = useCallback((marker: string) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const value = textRef.current
    const markerLen = marker.length

    if (start === end) {
      // No selection: insert empty markers at cursor
      const newValue = value.slice(0, start) + marker + marker + value.slice(end)
      setText(newValue)
      textRef.current = newValue
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + markerLen
      })
      return
    }

    const selected = value.slice(start, end)

    // Check if already wrapped (markers outside selection)
    const beforeStart = start - markerLen
    const afterEnd = end + markerLen
    const markersOutside =
      beforeStart >= 0 &&
      afterEnd <= value.length &&
      value.slice(beforeStart, start) === marker &&
      value.slice(end, afterEnd) === marker

    // Check if already wrapped (markers inside selection)
    const markersInside =
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length > 2 * markerLen

    if (markersOutside) {
      const newValue = value.slice(0, beforeStart) + selected + value.slice(afterEnd)
      setText(newValue)
      textRef.current = newValue
      requestAnimationFrame(() => {
        textarea.selectionStart = beforeStart
        textarea.selectionEnd = beforeStart + selected.length
      })
    } else if (markersInside) {
      const unwrapped = selected.slice(markerLen, -markerLen)
      const newValue = value.slice(0, start) + unwrapped + value.slice(end)
      setText(newValue)
      textRef.current = newValue
      requestAnimationFrame(() => {
        textarea.selectionStart = start
        textarea.selectionEnd = start + unwrapped.length
      })
    } else {
      const newValue = value.slice(0, start) + marker + selected + marker + value.slice(end)
      setText(newValue)
      textRef.current = newValue
      requestAnimationFrame(() => {
        textarea.selectionStart = start + markerLen
        textarea.selectionEnd = end + markerLen
      })
    }
  }, [])

  const handleSend = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = null
    }
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    textRef.current = ''
    if (isTypingRef.current) {
      isTypingRef.current = false
      onTyping(false)
    }
    textareaRef.current?.focus()
  }, [text, disabled, onSend, onTyping])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key === 'b') {
      e.preventDefault()
      wrapSelection('**')
      return
    }
    if (mod && e.key === 'i') {
      e.preventDefault()
      wrapSelection('*')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, wrapSelection])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value.slice(0, maxLength)
    setText(value)
    textRef.current = value

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = null
    }

    if (value.length > 0) {
      if (!isTypingRef.current) {
        isTypingRef.current = true
        onTyping(true)
      }
      typingTimeoutRef.current = setTimeout(() => {
        isTypingRef.current = false
        onTyping(false)
        typingTimeoutRef.current = null
      }, TYPING_TIMEOUT)
    } else if (isTypingRef.current) {
      isTypingRef.current = false
      onTyping(false)
    }
  }, [maxLength, onTyping])

  const showMic = !text.trim() && !disabled && !isRecording && !isSendingVoiceNote && !!onStartRecording

  const sendIcon = (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )

  if (isRecording) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.container}>
          <div className={styles.recordingBar}>
            <span className={styles.recordingDot} />
            <span className={styles.recordingTimer}>{formatRecordingTime(recordingDuration)}</span>
            {voiceNoteSizeWarningSeconds !== undefined && voiceNoteSizeWarningSeconds !== null && (
              <span className={styles.sizeLimitWarning}>
                limit in {voiceNoteSizeWarningSeconds}s
              </span>
            )}
          </div>
          <button
            className={styles.sendButton}
            onClick={onStopRecording}
            aria-label="Send voice note"
          >
            {sendIcon}
          </button>
          <button
            className={styles.cancelButton}
            onClick={onCancelRecording}
            aria-label="Cancel recording"
          >
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {voiceNoteError && <span className={styles.voiceNoteError}>{voiceNoteError}</span>}
      </div>
    )
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={disabled}
          rows={1}
          maxLength={maxLength}
          aria-label="Message input"
        />
        {showMic ? (
          <button
            className={styles.micButton}
            onClick={onStartRecording}
            aria-label="Record voice note"
          >
            <IconMic size={30} />
          </button>
        ) : (
          <button
            className={styles.sendButton}
            onClick={handleSend}
            disabled={disabled || !text.trim()}
            aria-label="Send message"
          >
            {sendIcon}
          </button>
        )}
      </div>
      {voiceNoteError && <span className={styles.voiceNoteError}>{voiceNoteError}</span>}
      {maxLength - text.length <= 0 && (
        <span className={styles.charLimitMax}>Character limit reached</span>
      )}
    </div>
  )
}
