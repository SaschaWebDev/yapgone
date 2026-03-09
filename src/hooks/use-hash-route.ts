import { useState, useEffect } from 'react'
import type { AppRoute } from '@/types'
import { decodeRoomSettings } from '@/room-settings'

export function parseFragment(hash: string): AppRoute {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment) {
    return { mode: 'home' }
  }

  const firstColon = fragment.indexOf(':')
  if (firstColon === -1) {
    return { mode: 'home' }
  }

  const secondColon = fragment.indexOf(':', firstColon + 1)
  const roomId = fragment.slice(0, firstColon)
  const creatorPubKey = secondColon === -1
    ? fragment.slice(firstColon + 1)
    : fragment.slice(firstColon + 1, secondColon)
  const encodedSettings = secondColon === -1 ? null : fragment.slice(secondColon + 1)

  if (!roomId || !creatorPubKey) {
    return { mode: 'home' }
  }

  return {
    mode: 'chat',
    roomId,
    creatorPubKey,
    roomSettings: decodeRoomSettings(encodedSettings),
  }
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
