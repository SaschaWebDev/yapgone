import { useState, useRef, useCallback, type CSSProperties, type PointerEvent } from 'react'

interface DraggableOptions {
  initialWidth: number
  initialHeight: number
  minWidth: number
  minHeight: number
}

interface DraggableResult {
  style: CSSProperties
  onDragStart: (e: PointerEvent) => void
  onResizeStart: (e: PointerEvent) => void
  onDoubleClick: () => void
  minimize: () => void
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const MOBILE_BREAKPOINT = 520

const noop = () => {}
const emptyResult: DraggableResult = { style: {}, onDragStart: noop, onResizeStart: noop, onDoubleClick: noop, minimize: noop }

export function useDraggable(options: DraggableOptions): DraggableResult {
  const { initialWidth, initialHeight, minWidth, minHeight } = options

  const [rect, setRect] = useState<Rect>(() => ({
    x: window.innerWidth - initialWidth - 16,
    y: window.innerHeight - initialHeight - 16,
    width: initialWidth,
    height: initialHeight,
  }))

  const [isMaximized, setIsMaximized] = useState(false)
  const savedRectRef = useRef<Rect | null>(null)
  const startRef = useRef<{ px: number; py: number; rect: Rect } | null>(null)

  const onDragStart = useCallback((e: PointerEvent) => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    startRef.current = { px: e.clientX, py: e.clientY, rect: { ...rect } }

    const onMove = (ev: globalThis.PointerEvent) => {
      const s = startRef.current
      if (!s) return
      const dx = ev.clientX - s.px
      const dy = ev.clientY - s.py
      const vw = window.innerWidth
      const vh = window.innerHeight
      setRect({
        ...s.rect,
        x: Math.max(-s.rect.width + 50, Math.min(vw - 50, s.rect.x + dx)),
        y: Math.max(0, Math.min(vh - 50, s.rect.y + dy)),
      })
    }

    const onUp = () => {
      startRef.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [rect])

  const onResizeStart = useCallback((e: PointerEvent) => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) return
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    startRef.current = { px: e.clientX, py: e.clientY, rect: { ...rect } }

    const onMove = (ev: globalThis.PointerEvent) => {
      const s = startRef.current
      if (!s) return
      const dx = ev.clientX - s.px
      const dy = ev.clientY - s.py
      const vw = window.innerWidth
      const vh = window.innerHeight
      setRect({
        ...s.rect,
        width: Math.max(minWidth, Math.min(vw - s.rect.x, s.rect.width + dx)),
        height: Math.max(minHeight, Math.min(vh - s.rect.y, s.rect.height + dy)),
      })
    }

    const onUp = () => {
      startRef.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [rect, minWidth, minHeight])

  const onDoubleClick = useCallback(() => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) return
    if (isMaximized) {
      const saved = savedRectRef.current
      if (saved) setRect(saved)
      savedRectRef.current = null
      setIsMaximized(false)
    } else {
      savedRectRef.current = { ...rect }
      const vw = window.innerWidth
      const vh = window.innerHeight
      setRect({ x: 16, y: 16, width: vw - 32, height: vh - 32 })
      setIsMaximized(true)
    }
  }, [isMaximized, rect])

  const minimize = useCallback(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    setIsMaximized(false)
    savedRectRef.current = null
    setRect({ x: vw - minWidth - 16, y: vh - minHeight - 16, width: minWidth, height: minHeight })
  }, [minWidth, minHeight])

  if (typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT) {
    return emptyResult
  }

  const style: CSSProperties = {
    position: 'fixed',
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  }

  return { style, onDragStart, onResizeStart, onDoubleClick, minimize }
}
