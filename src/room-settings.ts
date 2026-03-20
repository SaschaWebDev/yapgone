import { fromBase64Url, toBase64Url } from '@/crypto'

const SETTINGS_VERSION = 1
const DEFAULT_SAFEWORD_ITERATIONS = 120_000

export interface SafeWordSettings {
  saltB64: string
  hashB64: string
  iterations: number
}

export interface RoomSettings {
  usernameModeEnabled: boolean
  safeWord: SafeWordSettings | null
  maxParticipants: number
}

interface RoomSettingsPayloadV1 {
  v: number
  u?: 1
  s?: {
    s: string
    h: string
    i: number
  }
  m?: number // maxParticipants
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  usernameModeEnabled: false,
  safeWord: null,
  maxParticipants: 2,
}

function isSafeWordSettings(input: unknown): input is SafeWordSettings {
  if (typeof input !== 'object' || input === null) return false
  const obj = input as Record<string, unknown>
  return (
    typeof obj.saltB64 === 'string' &&
    typeof obj.hashB64 === 'string' &&
    typeof obj.iterations === 'number' &&
    Number.isInteger(obj.iterations) &&
    obj.iterations > 0
  )
}

export function normalizeRoomSettings(input?: Partial<RoomSettings> | null): RoomSettings {
  const maxParticipants = typeof input?.maxParticipants === 'number'
    && Number.isInteger(input.maxParticipants)
    && input.maxParticipants >= 2
    && input.maxParticipants <= 200
    ? input.maxParticipants
    : 2
  return {
    usernameModeEnabled: Boolean(input?.usernameModeEnabled),
    safeWord: isSafeWordSettings(input?.safeWord) ? input.safeWord : null,
    maxParticipants,
  }
}

export function encodeRoomSettings(settings: RoomSettings): string | null {
  const normalized = normalizeRoomSettings(settings)
  if (!normalized.usernameModeEnabled && !normalized.safeWord && normalized.maxParticipants === 2) {
    return null
  }

  const payload: RoomSettingsPayloadV1 = { v: SETTINGS_VERSION }
  if (normalized.usernameModeEnabled) {
    payload.u = 1
  }
  if (normalized.safeWord) {
    payload.s = {
      s: normalized.safeWord.saltB64,
      h: normalized.safeWord.hashB64,
      i: normalized.safeWord.iterations,
    }
  }
  if (normalized.maxParticipants !== 2) {
    payload.m = normalized.maxParticipants
  }

  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  return toBase64Url(bytes)
}

export function decodeRoomSettings(encoded: string | null | undefined): RoomSettings | null {
  if (!encoded) return null
  try {
    const bytes = fromBase64Url(encoded)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null) return null
    const payload = parsed as RoomSettingsPayloadV1
    if (payload.v !== SETTINGS_VERSION) return null

    const safeWord = payload.s && typeof payload.s === 'object'
      ? {
        saltB64: payload.s.s,
        hashB64: payload.s.h,
        iterations: payload.s.i,
      }
      : null

    return normalizeRoomSettings({
      usernameModeEnabled: payload.u === 1,
      safeWord,
      maxParticipants: typeof payload.m === 'number' ? payload.m : 2,
    })
  } catch {
    return null
  }
}

function trimSafeWord(input: string): string {
  return input.trim()
}

async function deriveSafeWordHash(input: string, saltB64: string, iterations: number): Promise<string> {
  const password = trimSafeWord(input)
  const saltSource = fromBase64Url(saltB64)
  const salt = new Uint8Array(saltSource.length)
  salt.set(saltSource)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    keyMaterial,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

export async function createSafeWordSettings(
  safeWord: string,
  iterations = DEFAULT_SAFEWORD_ITERATIONS,
): Promise<SafeWordSettings> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltB64 = toBase64Url(salt)
  const hashB64 = await deriveSafeWordHash(safeWord, saltB64, iterations)
  return { saltB64, hashB64, iterations }
}

export async function verifySafeWord(
  candidate: string,
  safeWord: SafeWordSettings,
): Promise<boolean> {
  const expected = fromBase64Url(safeWord.hashB64)
  const actual = fromBase64Url(
    await deriveSafeWordHash(candidate, safeWord.saltB64, safeWord.iterations),
  )
  if (expected.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= (expected[i] ?? 0) ^ (actual[i] ?? 0)
  }
  return diff === 0
}
