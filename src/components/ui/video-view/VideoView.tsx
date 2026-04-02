import { useRef, useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from '@/hooks/use-draggable'
import styles from './VideoView.module.css'

const MOBILE_MQ = '(max-width: 520px)'

interface VideoViewProps {
  remoteStream: MediaStream
  localStream: MediaStream | null
}

export function VideoView({ remoteStream, localStream }: VideoViewProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const fullscreenVideoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const draggable = useDraggable({
    initialWidth: 480,
    initialHeight: 360,
    minWidth: 240,
    minHeight: 180,
  })

  useEffect(() => {
    const video = isFullscreen ? fullscreenVideoRef.current : remoteVideoRef.current
    if (!video) return
    video.srcObject = remoteStream
    return () => {
      video.srcObject = null
    }
  }, [remoteStream, isFullscreen])

  useEffect(() => {
    const video = localVideoRef.current
    if (!video || !localStream) return
    video.srcObject = localStream
    return () => {
      video.srcObject = null
    }
  }, [localStream])

  const handleDoubleClick = useCallback(() => {
    if (window.matchMedia(MOBILE_MQ).matches) {
      setIsFullscreen(prev => !prev)
    } else {
      draggable.onDoubleClick()
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
          {localStream && (
            <video
              ref={localVideoRef}
              className={styles.pip}
              autoPlay
              playsInline
              muted
            />
          )}
        </div>
      ) : (
        <div
          className={styles.floating}
          style={draggable.style}
          onPointerDown={draggable.onDragStart}
          onDoubleClick={handleDoubleClick}
        >
          <div className={styles.dragHandle}>
            <span className={styles.dragLabel}>Video Call</span>
          </div>
          <div className={styles.videoContainer}>
            <video
              ref={remoteVideoRef}
              className={styles.floatingVideo}
              autoPlay
              playsInline
            />
            {localStream && (
              <video
                className={styles.pip}
                autoPlay
                playsInline
                muted
                ref={(el) => {
                  if (el) el.srcObject = localStream
                }}
              />
            )}
          </div>
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
