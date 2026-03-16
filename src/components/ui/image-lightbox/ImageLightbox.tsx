import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string
  fileName?: string
  onClose: () => void
  onDownload?: () => void
}

const MIN_SCALE = 1
const MAX_SCALE = 5

function clampTranslate(
  tx: number,
  ty: number,
  scale: number,
  imgWidth: number,
  imgHeight: number,
): { x: number; y: number } {
  if (scale <= 1) return { x: 0, y: 0 }
  const maxTx = (imgWidth * (scale - 1)) / 2
  const maxTy = (imgHeight * (scale - 1)) / 2
  return {
    x: Math.max(-maxTx, Math.min(maxTx, tx)),
    y: Math.max(-maxTy, Math.min(maxTy, ty)),
  }
}

export function ImageLightbox({ src, fileName, onClose, onDownload }: ImageLightboxProps) {
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const didDragRef = useRef(false)
  const lastPinchDistRef = useRef<number | null>(null)
  const pinchCenterRef = useRef<{ x: number; y: number } | null>(null)

  // Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const getImgDimensions = useCallback(() => {
    const img = imgRef.current
    if (!img) return { w: 0, h: 0 }
    return { w: img.offsetWidth, h: img.offsetHeight }
  }, [])

  // Backdrop click (also used on imageWrapper)
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget) return
      if (didDragRef.current) {
        didDragRef.current = false
        return
      }
      onClose()
    },
    [onClose],
  )

  // Wheel zoom toward cursor
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const img = imgRef.current
      if (!img) return

      const rect = img.getBoundingClientRect()
      const cursorX = e.clientX - rect.left - rect.width / 2
      const cursorY = e.clientY - rect.top - rect.height / 2

      setScale((prev) => {
        const delta = e.deltaY > 0 ? -0.3 : 0.3
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev + delta))

        if (next <= 1) {
          setTranslate({ x: 0, y: 0 })
          return next
        }

        const ratio = 1 - next / prev
        setTranslate((t) => {
          const { w, h } = getImgDimensions()
          return clampTranslate(
            t.x + cursorX * ratio,
            t.y + cursorY * ratio,
            next,
            w,
            h,
          )
        })
        return next
      })
    },
    [getImgDimensions],
  )

  // Double-click toggle 1x <-> 2x
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const img = imgRef.current
      if (!img) return

      const rect = img.getBoundingClientRect()
      const cursorX = e.clientX - rect.left - rect.width / 2
      const cursorY = e.clientY - rect.top - rect.height / 2

      setScale((prev) => {
        if (prev > 1) {
          setTranslate({ x: 0, y: 0 })
          return 1
        }
        const next = 2
        const { w, h } = getImgDimensions()
        setTranslate(clampTranslate(-cursorX, -cursorY, next, w, h))
        return next
      })
    },
    [getImgDimensions],
  )

  // Mouse drag for pan
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale <= 1 || e.button !== 0) return
      e.preventDefault()
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY, tx: translate.x, ty: translate.y }
    },
    [scale, translate],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !dragStartRef.current) return
      didDragRef.current = true
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      const { w, h } = getImgDimensions()
      setTranslate(
        clampTranslate(
          dragStartRef.current.tx + dx,
          dragStartRef.current.ty + dy,
          scale,
          w,
          h,
        ),
      )
    },
    [isDragging, scale, getImgDimensions],
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    dragStartRef.current = null
  }, [])

  // Pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const t0 = e.touches[0]
    const t1 = e.touches[1]
    if (e.touches.length === 2 && t0 && t1) {
      const dx = t0.clientX - t1.clientX
      const dy = t0.clientY - t1.clientY
      lastPinchDistRef.current = Math.hypot(dx, dy)
      pinchCenterRef.current = {
        x: (t0.clientX + t1.clientX) / 2,
        y: (t0.clientY + t1.clientY) / 2,
      }
    } else if (e.touches.length === 1 && t0 && scale > 1) {
      setIsDragging(true)
      dragStartRef.current = {
        x: t0.clientX,
        y: t0.clientY,
        tx: translate.x,
        ty: translate.y,
      }
    }
  }, [scale, translate])

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const t0 = e.touches[0]
      const t1 = e.touches[1]
      if (e.touches.length === 2 && t0 && t1 && lastPinchDistRef.current !== null) {
        const dx = t0.clientX - t1.clientX
        const dy = t0.clientY - t1.clientY
        const dist = Math.hypot(dx, dy)
        const ratio = dist / lastPinchDistRef.current

        setScale((prev) => {
          const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * ratio))
          if (next <= 1) {
            setTranslate({ x: 0, y: 0 })
          }
          return next
        })

        lastPinchDistRef.current = dist
      } else if (e.touches.length === 1 && t0 && isDragging && dragStartRef.current) {
        const dx = t0.clientX - dragStartRef.current.x
        const dy = t0.clientY - dragStartRef.current.y
        const { w, h } = getImgDimensions()
        setTranslate(
          clampTranslate(
            dragStartRef.current.tx + dx,
            dragStartRef.current.ty + dy,
            scale,
            w,
            h,
          ),
        )
      }
    },
    [isDragging, scale, getImgDimensions],
  )

  const handleTouchEnd = useCallback(() => {
    lastPinchDistRef.current = null
    pinchCenterRef.current = null
    setIsDragging(false)
    dragStartRef.current = null
  }, [])

  const imageClasses = [
    styles.image,
    !isDragging ? styles.imageSmooth : '',
    scale > 1 && !isDragging ? styles.imageGrab : '',
    isDragging ? styles.imageGrabbing : '',
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.toolbar}>
        {onDownload && (
          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={onDownload}
            aria-label="Download image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v13m0 0l-4-4m4 4l4-4" />
              <path d="M5 20h14" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={styles.toolbarBtn}
          onClick={onClose}
          aria-label="Close lightbox"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div
        ref={containerRef}
        className={styles.imageWrapper}
        onClick={handleOverlayClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <img
          ref={imgRef}
          className={imageClasses}
          src={src}
          alt={fileName ?? 'Full size image'}
          draggable={false}
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          }}
        />
      </div>
      {fileName && <span className={styles.fileName}>{fileName}</span>}
    </div>,
    document.body,
  )
}
