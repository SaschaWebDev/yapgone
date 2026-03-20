import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'

const DEFAULT_MAX_CLIENTS = 50
const INACTIVITY_TTL_MS = 30 * 60 * 1000
const MAX_MESSAGE_SIZE = 32768
const MAX_MESSAGES_PER_SECOND = 60

const SERVER_RESERVED_TYPES = new Set([
  'peer-joined', 'peer-left', 'peer-list', 'room-full', 'room-expired', 'room-closed', 'error',
])

const ClientAttachmentSchema = z.object({
  id: z.string(),
  messageTimestamps: z.array(z.number()),
  leftExplicitly: z.boolean().default(false),
})

type ClientAttachment = z.infer<typeof ClientAttachmentSchema>

export class ChatRoom extends DurableObject {
  private maxClients = DEFAULT_MAX_CLIENTS
  private peerHasJoined = false

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader !== 'websocket') {
      // Handle config initialization via internal POST
      if (request.method === 'POST') {
        const body: unknown = await request.json().catch(() => null)
        if (body && typeof body === 'object' && 'maxClients' in body) {
          const mc = (body as Record<string, unknown>).maxClients
          if (typeof mc === 'number' && mc > 0 && mc <= 200) {
            this.maxClients = mc
            await this.ctx.storage.put('maxClients', mc)
          }
        }
        return new Response('ok', { status: 200 })
      }
      return new Response('Expected WebSocket', { status: 426 })
    }

    // Restore maxClients from storage if not already set
    const stored = await this.ctx.storage.get<number>('maxClients')
    if (stored) this.maxClients = stored

    const existingSockets = this.ctx.getWebSockets()
    if (existingSockets.length >= this.maxClients) {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].send(JSON.stringify({ type: 'room-full' }))
      pair[1].close(4000, 'Room is full')
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    const pair = new WebSocketPair()
    const serverWs = pair[1]
    this.ctx.acceptWebSocket(serverWs)

    const clientId = crypto.randomUUID()
    const attachment: ClientAttachment = { id: clientId, messageTimestamps: [] }
    serverWs.serializeAttachment(attachment)

    const clientCount = existingSockets.length + 1

    if (existingSockets.length > 0) {
      this.peerHasJoined = true
    }

    // Send peer-list to the new client with all existing client IDs
    const existingClientIds: string[] = []
    for (const ws of existingSockets) {
      const raw = ws.deserializeAttachment()
      const parsed = ClientAttachmentSchema.safeParse(raw)
      if (parsed.success) {
        existingClientIds.push(parsed.data.id)
      }
    }
    serverWs.send(JSON.stringify({
      type: 'peer-list',
      clientIds: existingClientIds,
      yourId: clientId,
    }))

    // Notify existing clients about the new peer
    for (const ws of existingSockets) {
      ws.send(JSON.stringify({
        type: 'peer-joined',
        clientId,
        clientCount,
      }))
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
          const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
          const clientCount = remaining.length
          for (const peer of remaining) {
            try {
              peer.send(JSON.stringify({
                type: 'peer-left',
                clientId: client.id,
                clientCount,
              }))
            } catch { /* ignore */ }
          }
          const att = ws.deserializeAttachment() as ClientAttachment
          ws.serializeAttachment({ ...att, leftExplicitly: true })
          ws.close(1000, 'Left chat')
          if (remaining.length === 0) {
            await this.ctx.storage.setAlarm(Date.now() + 5000)
          }
          return
        }

        // Direct message: targeted delivery to a specific client
        if (parsed.type === 'direct') {
          const targetId = parsed.targetId
          if (typeof targetId !== 'string') {
            ws.send(JSON.stringify({ type: 'error', code: 'INVALID_TARGET', message: 'Invalid target ID' }))
            return
          }

          // Per-connection rate limiting
          const now = Date.now()
          client.messageTimestamps = client.messageTimestamps.filter(t => now - t < 1000)
          if (client.messageTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
            ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMIT', message: 'Too many messages' }))
            return
          }
          client.messageTimestamps.push(now)
          ws.serializeAttachment(client)

          // Find target WebSocket and deliver
          for (const peer of this.ctx.getWebSockets()) {
            if (peer === ws) continue
            const peerRaw = peer.deserializeAttachment()
            const peerParsed = ClientAttachmentSchema.safeParse(peerRaw)
            if (peerParsed.success && peerParsed.data.id === targetId) {
              try {
                // Attach senderId so target knows who sent it
                peer.send(JSON.stringify({
                  ...parsed,
                  senderId: client.id,
                }))
              } catch { /* ignore */ }
              break
            }
          }
          this.resetInactivityAlarm()
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
    const clientId = att.success ? att.data.id : 'unknown'

    if (!leftExplicitly) {
      // Only notify peers for unexpected disconnects (tab crash, network drop).
      // Explicit leaves already sent peer-left in the message handler.
      const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
      const clientCount = remaining.length
      for (const peer of remaining) {
        peer.send(JSON.stringify({
          type: 'peer-left',
          clientId,
          clientCount,
        }))
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
    const sockets = this.ctx.getWebSockets()

    // Creator waiting alone — re-arm instead of expiring
    if (!this.peerHasJoined && sockets.length > 0) {
      this.resetInactivityAlarm()
      return
    }

    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: 'room-expired' }))
      ws.close(1000, 'Room expired')
    }
    await this.ctx.storage.deleteAll()
  }

  private resetInactivityAlarm(): void {
    void this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TTL_MS)
  }
}
