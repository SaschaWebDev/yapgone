import { useRef, useState, useEffect, useCallback } from 'react'

export function useInactivityTimer(ttlMs: number, paused?: boolean): {
  remainingSeconds: number
  resetTimer: () => void
} {
  const lastActivityRef = useRef(Date.now())
  const [remainingSeconds, setRemainingSeconds] = useState(
    Math.ceil(ttlMs / 1000),
  )

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now()
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (paused) {
        lastActivityRef.current = Date.now()
        setRemainingSeconds(Math.ceil(ttlMs / 1000))
        return
      }
      const elapsed = Date.now() - lastActivityRef.current
      setRemainingSeconds(Math.max(0, Math.ceil((ttlMs - elapsed) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [ttlMs, paused])

  return { remainingSeconds, resetTimer }
}
