import { useRef, useState, useEffect, useCallback } from 'react'

export function useInactivityTimer(ttlMs: number): {
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
      const elapsed = Date.now() - lastActivityRef.current
      setRemainingSeconds(Math.max(0, Math.ceil((ttlMs - elapsed) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [ttlMs])

  return { remainingSeconds, resetTimer }
}
