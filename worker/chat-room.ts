import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'

const MAX_CLIENTS = 2
const INACTIVITY_TTL_MS = 30 * 60 * 1000
const MAX_MESSAGE_SIZE = 8192
const MAX_MESSAGES_PER_SECOND = 60

const SERVER_RESERVED_TYPES = new Set([
  'peer-joined', 'peer-left', 'room-full', 'room-expired', 'room-closed', 'error',
])

const ClientAttachmentSchema = z.object({
  id: z.string(),
  messageTimestamps: z.array(z.number()),
  leftExplicitly: z.boolean().default(false),
})

type ClientAttachment = z.infer<typeof ClientAttachmentSchema>

export class ChatRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const existingSockets = this.ctx.getWebSockets()
    if (existingSockets.length >= MAX_CLIENTS) {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].send(JSON.stringify({ type: 'room-full' }))
      pair[1].close(4000, 'Room is full')
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    const pair = new WebSocketPair()
    const serverWs = pair[1]
    this.ctx.acceptWebSocket(serverWs)

    const attachment: ClientAttachment = { id: crypto.randomUUID(), messageTimestamps: [] }
    serverWs.serializeAttachment(attachment)

    // Notify existing clients
    for (const ws of existingSockets) {
      ws.send(JSON.stringify({ type: 'peer-joined' }))
    }

    this.resetInactivityAlarm()

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const raw = ws.deserializeAttachment()
    const parsed = ClientAttachmentSchema.safeParse(raw)
    if (!parsed.success) return

    const client = parsed.data

    // Size check
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_MESSAGE_SIZE) {
      ws.send(JSON.stringify({ type: 'error', code: 'MSG_TOO_LARGE', message: 'Message exceeds size limit' }))
      return
    }

    // JSON validation
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message)

        // Block server-reserved message types from clients (anti-spoofing)
        if (typeof parsed.type === 'string' && SERVER_RESERVED_TYPES.has(parsed.type)) {
          ws.send(JSON.stringify({ type: 'error', code: 'RESERVED_TYPE', message: 'Cannot send server-reserved message type' }))
          return
        }

        // Server-handled command: close the room for everyone
        if (parsed.type === 'close-room') {
          for (const s of this.ctx.getWebSockets()) {
            try {
              s.send(JSON.stringify({ type: 'room-closed' }))
              s.close(1000, 'Room closed')
            } catch { /* ignore */ }
          }
          await this.ctx.storage.setAlarm(Date.now() + 5000)
          return
        }

        // Server-handled command: participant leaves
        if (parsed.type === 'leave') {
          for (const peer of this.ctx.getWebSockets()) {
            if (peer !== ws) {
              try {
                peer.send(JSON.stringify({ type: 'peer-left' }))
              } catch { /* ignore */ }
            }
          }
          const att = ws.deserializeAttachment() as ClientAttachment
          ws.serializeAttachment({ ...att, leftExplicitly: true })
          ws.close(1000, 'Left chat')
          const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
          if (remaining.length === 0) {
            await this.ctx.storage.setAlarm(Date.now() + 5000)
          }
          return
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' }))
        return
      }
    }

    // Per-connection rate limiting
    const now = Date.now()
    client.messageTimestamps = client.messageTimestamps.filter(t => now - t < 1000)
    if (client.messageTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
      ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMIT', message: 'Too many messages' }))
      return
    }
    client.messageTimestamps.push(now)

    // Write updated timestamps back to attachment
    ws.serializeAttachment(client)

    // Relay to all other connected clients
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(message)
        } catch {
          // Client may have disconnected
        }
      }
    }
    this.resetInactivityAlarm()
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const raw = ws.deserializeAttachment()
    const att = ClientAttachmentSchema.safeParse(raw)
    const leftExplicitly = att.success && att.data.leftExplicitly

    if (!leftExplicitly) {
      // Only notify peers for unexpected disconnects (tab crash, network drop).
      // Explicit leaves already sent peer-left in the message handler.
      const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
      for (const peer of remaining) {
        peer.send(JSON.stringify({ type: 'peer-left' }))
      }
    }

    const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
    if (remaining.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5000)
    }
  }

  async webSocketError(): Promise<void> {
    // Runtime handles WebSocket cleanup automatically
  }

  async alarm(): Promise<void> {
    // Close all connections and clean up
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(JSON.stringify({ type: 'room-expired' }))
      ws.close(1000, 'Room expired')
    }
    await this.ctx.storage.deleteAll()
  }

  private resetInactivityAlarm(): void {
    void this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TTL_MS)
  }
}
