import { useState, useCallback } from 'react'

interface UseRecentEmojisResult {
  recentEmojis: readonly string[]
  trackEmoji: (emoji: string) => void
}

export function useRecentEmojis(maxRecent = 18): UseRecentEmojisResult {
  const [recentEmojis, setRecentEmojis] = useState<readonly string[]>([])

  const trackEmoji = useCallback((emoji: string) => {
    setRecentEmojis(prev => {
      const filtered = prev.filter(e => e !== emoji)
      const next = [emoji, ...filtered]
      return next.length > maxRecent ? next.slice(0, maxRecent) : next
    })
  }, [maxRecent])

  return { recentEmojis, trackEmoji }
}
