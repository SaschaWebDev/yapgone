import { useState, useEffect } from 'react'
import type { AppRoute } from '@/types'

export function parseFragment(hash: string): AppRoute {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment) {
    return { mode: 'home' }
  }

  const colonIndex = fragment.indexOf(':')
  if (colonIndex === -1) {
    return { mode: 'home' }
  }

  const roomId = fragment.slice(0, colonIndex)
  const creatorPubKey = fragment.slice(colonIndex + 1)

  if (!roomId || !creatorPubKey) {
    return { mode: 'home' }
  }

  return { mode: 'chat', roomId, creatorPubKey }
}

export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() =>
    parseFragment(window.location.hash)
  )

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseFragment(window.location.hash))
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  return route
}
