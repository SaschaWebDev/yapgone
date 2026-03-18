import { z } from 'zod'
import { ChatRoom } from './chat-room'

interface Env {
  CHAT_ROOM: DurableObjectNamespace
  NOTEFADE_API_KEY?: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

// Per-isolate rate limiter for room creation
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_ROOMS = 10

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX_ROOMS
}

// Per-isolate rate limiter for notefade proxy
const notefadeRateLimitMap = new Map<string, { count: number; resetAt: number }>()
const NOTEFADE_RATE_LIMIT_WINDOW_MS = 60_000
const NOTEFADE_RATE_LIMIT_MAX = 5

function isNotefadeRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = notefadeRateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    notefadeRateLimitMap.set(ip, { count: 1, resetAt: now + NOTEFADE_RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  return entry.count > NOTEFADE_RATE_LIMIT_MAX
}

const NOTEFADE_API_URL = 'https://shard-api.notefade.com/api/v1/create-note'

const NotefadeRequestSchema = z.object({
  text: z.string().min(1).max(1800),
})

const NotefadeUpstreamResponseSchema = z.object({
  url: z.string(),
  shardId: z.string(),
  expiresAt: z.number(),
})

const ROOM_ID_PATTERN = /^[a-zA-Z0-9-]+$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // POST /api/rooms — create a new room
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      if (isRateLimited(ip)) {
        return jsonResponse({ error: 'Rate limit exceeded' }, 429)
      }

      const roomId = crypto.randomUUID()
      return jsonResponse({ roomId }, 201)
    }

    // GET /ws/:roomId — WebSocket upgrade to Durable Object
    const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9-]+)$/)
    if (wsMatch?.[1] && request.headers.get('Upgrade') === 'websocket') {
      const roomId = wsMatch[1]
      if (!ROOM_ID_PATTERN.test(roomId)) {
        return jsonResponse({ error: 'Invalid room ID' }, 400)
      }
      const id = env.CHAT_ROOM.idFromName(roomId)
      const stub = env.CHAT_ROOM.get(id)
      return stub.fetch(request)
    }

    // POST /api/notefade/create-note — proxy to notefade API
    if (url.pathname === '/api/notefade/create-note' && request.method === 'POST') {
      if (!env.NOTEFADE_API_KEY) {
        return jsonResponse({ error: 'Notefade integration not configured' }, 501)
      }

      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      if (isNotefadeRateLimited(ip)) {
        return jsonResponse({ error: 'Rate limit exceeded' }, 429)
      }

      const rawBody: unknown = await request.json().catch(() => null)
      const parsed = NotefadeRequestSchema.safeParse(rawBody)
      if (!parsed.success) {
        return jsonResponse({ error: 'Invalid request body' }, 400)
      }

      const upstream = await fetch(NOTEFADE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': env.NOTEFADE_API_KEY,
        },
        body: JSON.stringify({ text: parsed.data.text }),
      }).catch(() => null)

      if (!upstream || !upstream.ok) {
        return jsonResponse({ error: 'Upstream error' }, 502)
      }

      const upstreamBody: unknown = await upstream.json().catch(() => null)
      const upstreamParsed = NotefadeUpstreamResponseSchema.safeParse(upstreamBody)
      if (!upstreamParsed.success) {
        return jsonResponse({ error: 'Upstream error' }, 502)
      }

      return jsonResponse({ url: upstreamParsed.data.url }, 201)
    }

    return jsonResponse({ error: 'Not found' }, 404)
  },
}

export { ChatRoom }
