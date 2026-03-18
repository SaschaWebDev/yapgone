import { useRef, useEffect, useState } from 'react'
import { IconClose, IconFullscreen } from '../icons'
import styles from './ScreenShareView.module.css'

interface ScreenShareViewProps {
  stream: MediaStream
}

export function ScreenShareView({ stream }: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])

  useEffect(() => {
    if (!isFullscreen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isFullscreen])

  if (isFullscreen) {
    return (
      <div className={styles.overlay}>
        <video
          ref={videoRef}
          className={styles.overlayVideo}
          autoPlay
          playsInline
        />
        <button
          className={styles.closeButton}
          onClick={() => setIsFullscreen(false)}
          aria-label="Exit fullscreen"
        >
          <IconClose size={24} />
        </button>
        <button
          className={styles.exitButton}
          onClick={() => setIsFullscreen(false)}
        >
          Exit fullscreen
        </button>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <video
        ref={videoRef}
        className={styles.video}
        autoPlay
        playsInline
      />
      <button
        className={styles.fullscreenButton}
        onClick={() => setIsFullscreen(true)}
        aria-label="Enter fullscreen"
      >
        <IconFullscreen size={18} />
      </button>
    </div>
  )
}
