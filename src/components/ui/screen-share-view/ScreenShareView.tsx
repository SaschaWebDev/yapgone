import { useRef, useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from '@/hooks/use-draggable'
import styles from './ScreenShareView.module.css'

const MOBILE_MQ = '(max-width: 520px)'

interface ScreenShareViewProps {
  stream: MediaStream
}

export function ScreenShareView({ stream }: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const draggable = useDraggable({
    initialWidth: 720,
    initialHeight: 480,
    minWidth: 240,
    minHeight: 160,
  })

  useEffect(() => {
    const video = isFullscreen ? fullscreenVideoRef.current : videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream, isFullscreen])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (window.matchMedia(MOBILE_MQ).matches) {
      setIsFullscreen(prev => !prev)
    } else {
      draggable.onDoubleClick(e)
    }
  }, [draggable])

  return createPortal(
    <>
      {isFullscreen ? (
        <div className={styles.fullscreenOverlay} onDoubleClick={() => setIsFullscreen(false)}>
          <button
            type="button"
            className={styles.fullscreenClose}
            onClick={() => setIsFullscreen(false)}
            aria-label="Exit fullscreen"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <video
            ref={fullscreenVideoRef}
            className={styles.fullscreenVideo}
            autoPlay
            playsInline
          />
        </div>
      ) : (
        <div
          className={styles.floating}
          style={draggable.style}
          onPointerDown={draggable.onDragStart}
          onDoubleClick={handleDoubleClick}
        >
          <div className={styles.dragHandle}>
            <span className={styles.dragLabel}>Screen Share</span>
          </div>
          <video
            ref={videoRef}
            className={styles.floatingVideo}
            autoPlay
            playsInline
          />
          <div
            className={styles.resizeHandle}
            onPointerDown={draggable.onResizeStart}
          />
        </div>
      )}
    </>,
    document.body,
  )
}
