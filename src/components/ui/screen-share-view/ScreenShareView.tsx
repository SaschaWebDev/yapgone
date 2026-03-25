import { useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from '@/hooks/use-draggable'
import styles from './ScreenShareView.module.css'

interface ScreenShareViewProps {
  stream: MediaStream
}

export function ScreenShareView({ stream }: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const draggable = useDraggable({
    initialWidth: 720,
    initialHeight: 480,
    minWidth: 240,
    minHeight: 160,
  })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])

  return createPortal(
    <div
      className={styles.floating}
      style={draggable.style}
      onPointerDown={draggable.onDragStart}
      onDoubleClick={draggable.onDoubleClick}
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
    </div>,
    document.body,
  )
}
