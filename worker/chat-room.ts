import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'

const DEFAULT_MAX_CLIENTS = 50
const INACTIVITY_TTL_MS = 30 * 60 * 1000
const MAX_MESSAGE_SIZE = 32768
const MAX_MESSAGES_PER_SECOND = 60
const VOICE_MAGIC_BYTE = 0xAA
const RECONNECT_GRACE_MS = 8000
const DEPARTING_KEY_PREFIX = 'departing:'

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

    // Parse client-supplied identity from query string. Falls back to a
    // server-generated UUID for legacy clients (no resume capability).
    const url = new URL(request.url)
    const requestedCid = url.searchParams.get('cid')
    const clientId = requestedCid && requestedCid.length > 0 && requestedCid.length <= 64
      ? requestedCid
      : crypto.randomUUID()

    const existingSockets = this.ctx.getWebSockets()

    // Resume detection: if any current socket already has this clientId,
    // OR a recent close left a "departing" record, treat this as a resume.
    const departingKey = `${DEPARTING_KEY_PREFIX}${clientId}`
    const departingRecord = await this.ctx.storage.get<{ departedAt: number }>(departingKey)
    const isStaleDeparting = departingRecord
      ? Date.now() - departingRecord.departedAt > RECONNECT_GRACE_MS
      : false
    const hasDeparting = !!departingRecord && !isStaleDeparting

    // Collect ALL existing sockets carrying this clientId. Multiple zombies
    // can exist if previous reconnect cycles left sockets that haven't fully
    // closed yet — we must replace EVERY one of them, not just the first.
    const duplicateSockets: WebSocket[] = []
    for (const ws of existingSockets) {
      const raw = ws.deserializeAttachment()
      const parsed = ClientAttachmentSchema.safeParse(raw)
      if (parsed.success && parsed.data.id === clientId) {
        duplicateSockets.push(ws)
      }
    }

    const isResume = hasDeparting || duplicateSockets.length > 0

    if (!isResume) {
      // New client: count occupied slots = unique active cids + non-stale departing cids
      const activeCids = new Set<string>()
      for (const ws of existingSockets) {
        const raw = ws.deserializeAttachment()
        const parsed = ClientAttachmentSchema.safeParse(raw)
        if (parsed.success) activeCids.add(parsed.data.id)
      }
      const departingKeys = await this.ctx.storage.list({ prefix: DEPARTING_KEY_PREFIX })
      let departingCount = 0
      const now = Date.now()
      for (const [key, value] of departingKeys) {
        const rec = value as { departedAt: number } | undefined
        if (!rec) continue
        if (now - rec.departedAt > RECONNECT_GRACE_MS) continue
        const cid = key.slice(DEPARTING_KEY_PREFIX.length)
        if (!activeCids.has(cid)) departingCount += 1
      }
      const occupied = activeCids.size + departingCount

      if (occupied >= this.maxClients) {
        const pair = new WebSocketPair()
        this.ctx.acceptWebSocket(pair[1])
        pair[1].send(JSON.stringify({ type: 'room-full' }))
        pair[1].close(4000, 'Room is full')
        return new Response(null, { status: 101, webSocket: pair[0] })
      }
    }

    // Close every duplicate active socket for this clientId (zombies, second
    // tab, stale connections that haven't fired close yet).
    for (const dup of duplicateSockets) {
      try {
        const raw = dup.deserializeAttachment()
        const att = ClientAttachmentSchema.safeParse(raw)
        if (att.success) {
          dup.serializeAttachment({ ...att.data, leftExplicitly: true })
        }
        dup.close(1000, 'Replaced by reconnect')
      } catch {
        // ignore
      }
    }

    // Clear the departing record so the grace-period check skips this cid.
    if (departingRecord) {
      await this.ctx.storage.delete(departingKey)
    }

    const pair = new WebSocketPair()
    const serverWs = pair[1]
    this.ctx.acceptWebSocket(serverWs)

    const attachment: ClientAttachment = { id: clientId, messageTimestamps: [] }
    serverWs.serializeAttachment(attachment)

    // Recompute the post-acceptance roster. Build the unique cid set from the
    // FULL socket list (deduped naturally by Set) and subtract this client's
    // own cid. This is robust against zombie sockets that might still be in
    // getWebSockets() carrying this clientId — they cannot inflate the count.
    const duplicateSet = new Set(duplicateSockets)
    const allCids = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === serverWs) continue
      if (duplicateSet.has(ws)) continue
      const raw = ws.deserializeAttachment()
      const parsed = ClientAttachmentSchema.safeParse(raw)
      if (parsed.success && parsed.data.id !== clientId) {
        allCids.add(parsed.data.id)
      }
    }
    const rosterCids = allCids
    const roster = this.ctx.getWebSockets().filter(
      s => s !== serverWs && !duplicateSet.has(s),
    )
    const clientCount = rosterCids.size + 1

    if (rosterCids.size > 0) {
      this.peerHasJoined = true
    }

    // Send peer-list to the new client with all existing client IDs
    serverWs.send(JSON.stringify({
      type: 'peer-list',
      clientIds: Array.from(rosterCids),
      yourId: clientId,
    }))

    // Notify existing peers ONLY for genuinely new joins, not resumes.
    if (!isResume) {
      for (const ws of roster) {
        ws.send(JSON.stringify({
          type: 'peer-joined',
          clientId,
          clientCount,
        }))
      }
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
          const remainingCids = new Set<string>()
          for (const peer of remaining) {
            const peerRaw = peer.deserializeAttachment()
            const peerParsed = ClientAttachmentSchema.safeParse(peerRaw)
            if (peerParsed.success && peerParsed.data.id !== client.id) {
              remainingCids.add(peerParsed.data.id)
            }
          }
          const clientCount = remainingCids.size
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

    // Binary voice frames: bypass rate limiting and broadcast immediately
    if (message instanceof ArrayBuffer && message.byteLength > 0) {
      const firstByte = new Uint8Array(message, 0, 1)[0]
      if (firstByte === VOICE_MAGIC_BYTE) {
        for (const peer of this.ctx.getWebSockets()) {
          if (peer !== ws) {
            try { peer.send(message) } catch { /* disconnected */ }
          }
        }
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

    if (leftExplicitly) {
      // Explicit leaves already notified peers in the message handler.
      // No grace period: clean up any departing record for this cid.
      await this.ctx.storage.delete(`${DEPARTING_KEY_PREFIX}${clientId}`)
      const remaining = this.ctx.getWebSockets().filter(s => s !== ws)
      if (remaining.length === 0) {
        await this.ctx.storage.setAlarm(Date.now() + 5000)
      }
      return
    }

    // Unexpected disconnect (tab crash, network drop, mobile background).
    // Mark as departing and defer the peer-left notification by RECONNECT_GRACE_MS
    // so a quick reconnect with the same clientId is treated as a resume.
    const departedAt = Date.now()
    await this.ctx.storage.put(`${DEPARTING_KEY_PREFIX}${clientId}`, { departedAt })

    this.ctx.waitUntil(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          void this.finalizeDeparture(clientId, departedAt).finally(resolve)
        }, RECONNECT_GRACE_MS + 100)
      }),
    )
  }

  private async finalizeDeparture(clientId: string, departedAt: number): Promise<void> {
    const key = `${DEPARTING_KEY_PREFIX}${clientId}`
    const record = await this.ctx.storage.get<{ departedAt: number }>(key)
    // If record is missing or has been replaced by a newer departure, this
    // particular departure was already resolved (resumed or superseded).
    if (!record || record.departedAt !== departedAt) return

    // Confirm the cid is still NOT held by any active socket (resume check).
    const sockets = this.ctx.getWebSockets()
    for (const ws of sockets) {
      const raw = ws.deserializeAttachment()
      const parsed = ClientAttachmentSchema.safeParse(raw)
      if (parsed.success && parsed.data.id === clientId) {
        // Resumed via a new socket — drop the departing record and bail.
        await this.ctx.storage.delete(key)
        return
      }
    }

    // Truly gone. Remove the departing record and notify remaining peers.
    await this.ctx.storage.delete(key)

    const activeCids = new Set<string>()
    for (const ws of sockets) {
      const raw = ws.deserializeAttachment()
      const parsed = ClientAttachmentSchema.safeParse(raw)
      if (parsed.success) activeCids.add(parsed.data.id)
    }
    const clientCount = activeCids.size

    for (const peer of sockets) {
      try {
        peer.send(JSON.stringify({
          type: 'peer-left',
          clientId,
          clientCount,
        }))
      } catch {
        // ignore
      }
    }

    if (sockets.length === 0) {
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
