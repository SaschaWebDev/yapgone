import { ChatRoom } from './chat-room'

interface Env {
  CHAT_ROOM: DurableObjectNamespace
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

    return jsonResponse({ error: 'Not found' }, 404)
  },
}

export { ChatRoom }
