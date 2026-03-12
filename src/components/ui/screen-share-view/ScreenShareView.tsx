import { useRef, useEffect } from 'react'
import styles from './ScreenShareView.module.css'

interface ScreenShareViewProps {
  stream: MediaStream
}

export function ScreenShareView({ stream }: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])

  return (
    <div className={styles.container}>
      <video
        ref={videoRef}
        className={styles.video}
        autoPlay
        playsInline
      />
    </div>
  )
}
