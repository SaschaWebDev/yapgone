export const MAX_MESSAGE_LENGTH = 2000
export const VOICE_NOTE_MAX_DURATION_MS = 120_000
export const VOICE_NOTE_MAX_BYTES = 128_000
export const VOICE_NOTE_CHUNK_BYTES = 2_000
export const VOICE_NOTE_ASSEMBLY_TIMEOUT_MS = 60_000

export const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000 // 30 minutes

export const MAX_SKIPPED_KEYS = 100

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? ''

export const COPY_FLASH_FADE_MS = 1200
export const COPY_FLASH_DONE_MS = 1600
export const VOICE_CONNECT_TIMEOUT_MS = 20_000
export const VOICE_DISCONNECTED_GRACE_MS = 5_000

export const STORAGE_KEYS = {
  THEME: 'yapgone-theme',
  CREATOR_PREFIX: 'yapgone-creator-',
} as const
