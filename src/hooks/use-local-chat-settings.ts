import { useState, useCallback } from 'react'
import { STORAGE_KEYS } from '@/constants'

export interface LocalChatSettings {
  autoScroll: boolean
  soundEnabled: boolean
}

const DEFAULTS: LocalChatSettings = {
  autoScroll: true,
  soundEnabled: true,
}

function loadSettings(): LocalChatSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CHAT_SETTINGS)
    if (!raw) return DEFAULTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
    const obj = parsed as Record<string, unknown>
    return {
      autoScroll: typeof obj.autoScroll === 'boolean' ? obj.autoScroll : DEFAULTS.autoScroll,
      soundEnabled: typeof obj.soundEnabled === 'boolean' ? obj.soundEnabled : DEFAULTS.soundEnabled,
    }
  } catch {
    return DEFAULTS
  }
}

export function useLocalChatSettings() {
  const [settings, setSettings] = useState<LocalChatSettings>(loadSettings)

  const updateSetting = useCallback(<K extends keyof LocalChatSettings>(
    key: K,
    value: LocalChatSettings[K],
  ) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(STORAGE_KEYS.CHAT_SETTINGS, JSON.stringify(next))
      } catch {
        // localStorage full — ignore
      }
      return next
    })
  }, [])

  return { settings, updateSetting }
}
