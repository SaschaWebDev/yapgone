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

export const FILE_MAX_IMAGE_BYTES = 5 * 1024 * 1024    // 5 MiB
export const FILE_MAX_GENERAL_BYTES = 10 * 1024 * 1024  // 10 MiB
export const FILE_MAX_VIDEO_BYTES = 50 * 1024 * 1024    // 50 MiB
export const FILE_CHUNK_BYTES = 16_000                   // 16 KiB
export const FILE_ASSEMBLY_TIMEOUT_MS = 120_000          // 2 min
export const FILE_MAX_CONCURRENT_TRANSFERS = 3
export const FILE_SEND_DELAY_MS = 25

export const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
])

export const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
])

export const GALLERY_MAX_IMAGES = 5
export const GALLERY_IMAGE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp,image/avif'

export const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000 // 30 minutes

export const MAX_SKIPPED_KEYS = 100

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? ''

export const COPY_FLASH_FADE_MS = 1200
export const COPY_FLASH_DONE_MS = 1600
export const VOICE_CONNECT_TIMEOUT_MS = 20_000
export const VOICE_DISCONNECTED_GRACE_MS = 5_000
export const SAFE_WORD_MAX_ATTEMPTS = 3
export const USERNAME_MAX_LENGTH = 24
export const TIMED_MESSAGE_TTL_MS = 15_000
export const TIMED_MESSAGE_FADEOUT_MS = 300
export const TIMED_VOICE_FALLBACK_TTL_MS = 300_000

export const NOTEFADE_MAX_NOTE_LENGTH = 1800

export const POLL_MAX_OPTIONS = 20
export const POLL_MAX_QUESTION_LENGTH = 500
export const POLL_MAX_OPTION_LENGTH = 200

export const PREDICTION_MAX_OPTIONS = 10
export const PREDICTION_MAX_TITLE_LENGTH = 300
export const PREDICTION_MAX_OPTION_LENGTH = 200
export const PREDICTION_TIMER_INTERVAL_MS = 50
export const PREDICTION_DURATION_OPTIONS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000] as const

export const DEFAULT_TITLE = 'yapgone'

export const VOICE_E2EE_ENABLED = true

export const VOICE_VAD_THRESHOLD = 40
export const VOICE_VAD_HOLD_MS = 150
export const VOICE_ANALYSER_FFT_SIZE = 256
export const VOICE_ANALYSER_SMOOTHING = 0.6
export const VOICE_WAVEFORM_BAR_COUNT = 14

export const GROUP_VOICE_SAMPLE_RATE = 8000
export const GROUP_VOICE_FRAME_SIZE = 256
export const GROUP_VOICE_MAGIC_BYTE = 0xAA
export const GROUP_VOICE_MAX_PARTICIPANTS = 10
export const GROUP_VOICE_JITTER_BUFFER_SIZE = 3

export const MAX_GROUP_SIZE = 50
export const DEFAULT_MAX_PARTICIPANTS = 2

export const STORAGE_KEYS = {
  THEME: 'yapgone-theme',
  CREATOR_PREFIX: 'yapgone-creator-',
  SAFEWORD_LOCK_PREFIX: 'yapgone-safeword-lock-',
  CHAT_SETTINGS: 'yapgone-chat-settings',
} as const
