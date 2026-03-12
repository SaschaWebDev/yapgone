import { useState, useRef, useCallback, useEffect } from 'react'
import { formatMessage } from '@/utils/format-message'
import { EmojiQuickPick } from '../emoji-picker'
import type { MessageReaction } from '@/hooks/use-chat'
import styles from './MessageBubble.module.css'

interface MessageBubbleProps {
  kind?: 'text' | 'audio'
  text?: string
  audioUrl?: string
  durationMs?: number
  sender: 'self' | 'peer' | 'system'
  displayName?: string
  timestamp: number
  reactions?: MessageReaction[]
  replyTo?: string
  replyPreview?: string
  msgId?: string
  onReact?: (emoji: string) => void
  onReply?: () => void
  onReplyClick?: () => void
  onCopy?: () => void
  onDownload?: () => void
  skipAnimation?: boolean
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

const SPEEDS = [1, 1.5, 2] as const

function AudioPlayer({ src, durationMs, isSelf, timestamp }: { src: string; durationMs?: number; isSelf: boolean; timestamp: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0)
  const [speedIndex, setSpeedIndex] = useState(0)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setProgress(audio.currentTime / audio.duration)
        setCurrentTime(audio.currentTime)
      }
    }

    const onLoadedMetadata = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration)
      }
    }

    const onEnded = () => {
      setIsPlaying(false)
      setProgress(0)
      setCurrentTime(0)
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play().catch(() => setIsPlaying(false))
      setIsPlaying(true)
    }
  }, [isPlaying])

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    const track = trackRef.current
    if (!audio || !track || !audio.duration || !isFinite(audio.duration)) return
    const rect = track.getBoundingClientRect()
    const x = e.clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    audio.currentTime = ratio * audio.duration
    setProgress(ratio)
    setCurrentTime(audio.currentTime)
  }, [])

  const cycleSpeed = useCallback(() => {
    const next = (speedIndex + 1) % SPEEDS.length
    setSpeedIndex(next)
    const rate = SPEEDS[next] ?? 1
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }, [speedIndex])

  const timeLabel = isPlaying && duration > 0
    ? formatSeconds(duration - currentTime)
    : formatSeconds(duration)

  const formattedTime = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={styles.audioPlayer}>
      <div className={styles.audioControls}>
        <audio ref={audioRef} src={src} preload="metadata" />
        <button
          className={`${styles.playButton} ${isSelf ? styles.playButtonSelf : styles.playButtonPeer}`}
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="7 3 21 12 7 21" />
            </svg>
          )}
        </button>
        <div
          ref={trackRef}
          className={`${styles.progressTrack} ${isSelf ? styles.progressTrackSelf : styles.progressTrackPeer}`}
          onClick={handleSeek}
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`${styles.progressFill} ${isSelf ? styles.progressFillSelf : styles.progressFillPeer}`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className={styles.audioDuration}>{timeLabel}</span>
      </div>
      <div className={styles.audioMeta}>
        <button
          className={`${styles.speedBadge} ${isSelf ? styles.speedBadgeSelf : styles.speedBadgePeer} ${speedIndex > 0 ? styles.speedActive : ''}`}
          onClick={cycleSpeed}
          aria-label={`Playback speed ${SPEEDS[speedIndex]}×`}
        >
          {SPEEDS[speedIndex]}×
        </button>
        <div className={styles.audioMetaRight}>
          <time className={styles.time} dateTime={new Date(timestamp).toISOString()}>
            {formattedTime}
          </time>
        </div>
      </div>
    </div>
  )
}

interface GroupedReaction {
  emoji: string
  count: number
  hasSelf: boolean
}

function groupReactions(reactions: MessageReaction[]): GroupedReaction[] {
  const map = new Map<string, { count: number; hasSelf: boolean }>()
  for (const r of reactions) {
    const existing = map.get(r.emoji)
    if (existing) {
      existing.count++
      if (r.fromSelf) existing.hasSelf = true
    } else {
      map.set(r.emoji, { count: 1, hasSelf: r.fromSelf })
    }
  }
  return Array.from(map.entries()).map(([emoji, { count, hasSelf }]) => ({
    emoji,
    count,
    hasSelf,
  }))
}

export function MessageBubble({
  kind = 'text',
  text,
  audioUrl,
  durationMs,
  sender,
  displayName,
  timestamp,
  reactions = [],
  replyTo,
  replyPreview,
  msgId,
  onReact,
  onReply,
  onReplyClick,
  onCopy,
  onDownload,
  skipAnimation,
}: MessageBubbleProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const [compact, setCompact] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  const handleCopy = useCallback(() => {
    if (!onCopy || copyDone) return
    onCopy()
    setCopyDone(true)
    copyTimerRef.current = setTimeout(() => setCopyDone(false), 1200)
  }, [onCopy, copyDone])

  const handleDoubleClick = useCallback(() => {
    if (onReact && sender !== 'system') {
      setPickerOpen(prev => !prev)
    }
  }, [onReact, sender])

  const handleTouchStart = useCallback(() => {
    if (!onReact || sender === 'system') return
    longPressRef.current = setTimeout(() => {
      setPickerOpen(true)
    }, 500)
  }, [onReact, sender])

  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (longPressRef.current) clearTimeout(longPressRef.current)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setCompact(el.offsetHeight < 100)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleEmojiSelect = useCallback((emoji: string) => {
    setPickerOpen(false)
    onReact?.(emoji)
  }, [onReact])

  const handleReactionBadgeClick = useCallback((emoji: string, hasSelf: boolean) => {
    onReact?.(emoji)
    if (hasSelf) {
      // Will toggle off — already handled by parent via action='remove'
    }
  }, [onReact])

  if (sender === 'system') {
    return (
      <div className={`${styles.system}${skipAnimation ? ` ${styles.noAnimation}` : ''}`} role="listitem">
        <p className={styles.systemText}>{text ?? ''}</p>
      </div>
    )
  }

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const isSelf = sender === 'self'
  const grouped = groupReactions(reactions)

  return (
    <div className={`${styles.bubbleWrapper} ${isSelf ? styles.bubbleWrapperSelf : styles.bubbleWrapperPeer}${kind === 'audio' ? ` ${styles.bubbleWrapperAudio}` : ''}`} data-msg-id={msgId} role="listitem">
      <div
        ref={bubbleRef}
        className={`${styles.bubble} ${isSelf ? styles.self : styles.peer}${compact && kind !== 'audio' ? ` ${styles.compactActions}` : ''}${kind === 'audio' ? ` ${styles.audioActions}` : ''}${skipAnimation ? ` ${styles.noAnimation}` : ''}`}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {displayName && <p className={styles.displayName}>{displayName}</p>}
        {replyTo && replyPreview && (
          <div
            className={`${styles.quoteBlock}${onReplyClick ? ` ${styles.quoteBlockClickable}` : ''}`}
            onClick={onReplyClick}
            role={onReplyClick ? 'button' : undefined}
          >
            <span className={styles.quoteText}>{replyPreview}</span>
          </div>
        )}
        {kind === 'audio' && audioUrl ? (
          <AudioPlayer src={audioUrl} durationMs={durationMs} isSelf={isSelf} timestamp={timestamp} />
        ) : (
          <>
            <p className={styles.text}>{text ? formatMessage(text) : ''}</p>
            <time className={styles.time} dateTime={new Date(timestamp).toISOString()}>
              {time}
            </time>
          </>
        )}
        {onCopy && kind === 'text' && (
          <button
            type="button"
            className={`${styles.copyButton} ${copyDone ? styles.copyDone : ''}`}
            onClick={handleCopy}
            aria-label={copyDone ? 'Copied' : 'Copy message'}
          >
            {copyDone ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        )}
        {onDownload && kind === 'audio' && (
          <button
            type="button"
            className={styles.downloadActionButton}
            onClick={onDownload}
            aria-label="Download voice note"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v13m0 0l-4-4m4 4l4-4" />
              <path d="M5 20h14" />
            </svg>
          </button>
        )}
        {onReply && (
          <button
            type="button"
            className={styles.replyButton}
            onClick={onReply}
            aria-label="Reply"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 17l-5-5 5-5" />
              <path d="M4 12h11a4 4 0 0 1 0 8h-1" />
            </svg>
          </button>
        )}
        {onReact && (
          <button
            type="button"
            className={styles.emojiTrigger}
            onClick={() => setPickerOpen(prev => !prev)}
            aria-label="React"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
        )}
      </div>
      {grouped.length > 0 && (
        <div className={`${styles.reactionBar} ${isSelf ? styles.reactionBarSelf : ''}`}>
          {grouped.map(r => (
            <button
              key={r.emoji}
              type="button"
              className={`${styles.reactionBadge} ${r.hasSelf ? styles.reactionBadgeSelf : ''}`}
              onClick={() => handleReactionBadgeClick(r.emoji, r.hasSelf)}
            >
              <span className={styles.reactionEmoji}>{r.emoji}</span>
              {r.count > 1 && <span className={styles.reactionCount}>{r.count}</span>}
            </button>
          ))}
        </div>
      )}
      {pickerOpen && (
        <div className={`${styles.pickerAnchor} ${isSelf ? styles.pickerAnchorSelf : ''}`}>
          <EmojiQuickPick
            onSelect={handleEmojiSelect}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
