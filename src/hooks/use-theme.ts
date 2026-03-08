import { useState, useCallback, useEffect } from 'react'
import { STORAGE_KEYS } from '@/constants'

type Theme = 'dark' | 'light'

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEYS.THEME)
  if (stored === 'dark' || stored === 'light') {
    return stored
  }
  if (window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem(STORAGE_KEYS.THEME, next)
      return next
    })
  }, [])

  return { theme, toggleTheme } as const
}
