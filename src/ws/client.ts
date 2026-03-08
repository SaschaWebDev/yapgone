import type { ClientMessage, ServerMessage } from './protocol'
import { ClientMessageSchema, ServerMessageSchema } from './protocol'

export interface ChatWebSocket {
  connect(url: string): void
  send(message: ClientMessage): void
  close(): void
  readonly readyState: number
  onOpen: (() => void) | null
  onMessage: ((message: ServerMessage | ClientMessage) => void) | null
  onClose: ((code: number, reason: string) => void) | null
  onError: ((error: unknown) => void) | null
}

export function createWebSocket(): ChatWebSocket {
  let ws: WebSocket | null = null

  const socket: ChatWebSocket = {
    get readyState() {
      return ws?.readyState ?? WebSocket.CLOSED
    },

    onOpen: null,
    onMessage: null,
    onClose: null,
    onError: null,

    connect(url: string) {
      ws = new WebSocket(url)

      ws.onopen = () => {
        socket.onOpen?.()
      }

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        try {
          const json: unknown = JSON.parse(event.data)

          // Try server message first, then client message (relayed)
          const serverResult = ServerMessageSchema.safeParse(json)
          if (serverResult.success) {
            socket.onMessage?.(serverResult.data)
            return
          }

          const clientResult = ClientMessageSchema.safeParse(json)
          if (clientResult.success) {
            socket.onMessage?.(clientResult.data)
            return
          }
        } catch {
          // Invalid JSON — ignore
        }
      }

      ws.onclose = (event: CloseEvent) => {
        socket.onClose?.(event.code, event.reason)
      }

      ws.onerror = (event: Event) => {
        socket.onError?.(event)
      }
    },

    send(message: ClientMessage) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      }
    },

    close() {
      ws?.close(1000)
    },
  }

  return socket
}
