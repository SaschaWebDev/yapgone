import { useState, useRef, useCallback, useEffect } from 'react'
import styles from './MessageBubble.module.css'

interface MessageBubbleProps {
  kind?: 'text' | 'audio'
  text?: string
  audioUrl?: string
  durationMs?: number
  sender: 'self' | 'peer' | 'system'
  timestamp: number
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function AudioPlayer({ src, durationMs, isSelf }: { src: string; durationMs?: number; isSelf: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0)

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

  const timeLabel = isPlaying && duration > 0
    ? formatSeconds(duration - currentTime)
    : formatSeconds(duration)

  return (
    <div className={styles.audioPlayer}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        className={`${styles.playButton} ${isSelf ? styles.playButtonSelf : styles.playButtonPeer}`}
        onClick={togglePlay}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
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
  )
}

export function MessageBubble({ kind = 'text', text, audioUrl, durationMs, sender, timestamp }: MessageBubbleProps) {
  if (sender === 'system') {
    return (
      <div className={styles.system} role="listitem">
        <p className={styles.systemText}>{text ?? ''}</p>
      </div>
    )
  }

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const isSelf = sender === 'self'

  return (
    <div
      className={`${styles.bubble} ${isSelf ? styles.self : styles.peer}`}
      role="listitem"
    >
      {kind === 'audio' && audioUrl ? (
        <AudioPlayer src={audioUrl} durationMs={durationMs} isSelf={isSelf} />
      ) : (
        <p className={styles.text}>{text ?? ''}</p>
      )}
      <time className={styles.time} dateTime={new Date(timestamp).toISOString()}>
        {time}
      </time>
    </div>
  )
}
