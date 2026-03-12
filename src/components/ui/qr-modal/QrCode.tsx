import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import styles from './QrCode.module.css'

interface QrCodeProps {
  url: string
  size?: number
}

export function QrCode({ url, size = 160 }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
    void QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 2,
      color: {
        dark: isDark ? '#e8e8e8' : '#1a1a1a',
        light: isDark ? '#1a1a1a' : '#ffffff',
      },
    })
  }, [url, size])

  return (
    <div className={styles.container}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <p className={styles.hint}>or scan to join</p>
    </div>
  )
}
