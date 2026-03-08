export const MAX_MESSAGE_LENGTH = 2000

export const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000 // 30 minutes

export const MAX_SKIPPED_KEYS = 100

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? ''

export const COPY_FLASH_FADE_MS = 1200
export const COPY_FLASH_DONE_MS = 1600

export const STORAGE_KEYS = {
  THEME: 'yapgone-theme',
  CREATOR_PREFIX: 'yapgone-creator-',
} as const
