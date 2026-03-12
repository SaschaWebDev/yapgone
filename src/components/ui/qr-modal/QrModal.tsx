import { useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import styles from './QrModal.module.css'

interface QrModalProps {
  url: string
  open: boolean
  onClose: () => void
}

export function QrModal({ url, open, onClose }: QrModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!open || !canvasRef.current) return
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
    void QRCode.toCanvas(canvasRef.current, url, {
      width: 256,
      margin: 2,
      color: {
        dark: isDark ? '#e8e8e8' : '#1a1a1a',
        light: isDark ? '#1a1a1a' : '#ffffff',
      },
    })
  }, [open, url])

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.card}>
        <button className={styles.close} onClick={onClose} aria-label="Close">
          &times;
        </button>
        <canvas ref={canvasRef} className={styles.canvas} />
        <p className={styles.hint}>Scan to join this chat</p>
      </div>
    </div>
  )
}
