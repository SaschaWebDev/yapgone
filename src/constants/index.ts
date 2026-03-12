export const MAX_MESSAGE_LENGTH = 65536
export const VOICE_NOTE_MAX_DURATION_MS = 120_000
export const VOICE_NOTE_MAX_BYTES = 768_000
export const VOICE_NOTE_SIZE_WARNING_THRESHOLD_S = 10
export const VOICE_NOTE_DURATION_WARNING_THRESHOLD_S = 10
export const VOICE_NOTE_SIZE_SAFETY_RATIO = 0.95
export const VOICE_NOTE_TIMESLICE_MS = 1000
export const VOICE_NOTE_CHUNK_BYTES = 4_000
export const VOICE_NOTE_AUDIO_BITRATE = 48_000
export const VOICE_NOTE_ASSEMBLY_TIMEOUT_MS = 60_000

export const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000 // 30 minutes
export const INACTIVITY_WARNING_THRESHOLD_S = 5 * 60
export const INACTIVITY_URGENT_THRESHOLD_S = 60

export const MAX_SKIPPED_KEYS = 100

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? ''

export const COPY_FLASH_FADE_MS = 1200
export const COPY_FLASH_DONE_MS = 1600
export const VOICE_CONNECT_TIMEOUT_MS = 20_000
export const VOICE_DISCONNECTED_GRACE_MS = 5_000
export const SAFE_WORD_MAX_ATTEMPTS = 3
export const USERNAME_MAX_LENGTH = 24

export const DEFAULT_TITLE = 'yapgone'

export const VOICE_E2EE_ENABLED = true

export const STORAGE_KEYS = {
  THEME: 'yapgone-theme',
  CREATOR_PREFIX: 'yapgone-creator-',
  SAFEWORD_LOCK_PREFIX: 'yapgone-safeword-lock-',
  CHAT_SETTINGS: 'yapgone-chat-settings',
} as const
