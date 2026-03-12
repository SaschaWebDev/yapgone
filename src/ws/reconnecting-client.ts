import { createWebSocket } from './client'
import type { ChatWebSocket } from './client'
import type { ClientMessage, ServerMessage } from './protocol'

export interface ReconnectingChatWebSocket extends ChatWebSocket {
  onReconnecting: (() => void) | null
  onReconnected: (() => void) | null
  onReconnectFailed: (() => void) | null
  cancelReconnect(): void
}

const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

function backoffDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt)
  const jitter = Math.random() * BASE_DELAY_MS
  return Math.min(exponential + jitter, MAX_DELAY_MS)
}

export function createReconnectingWebSocket(): ReconnectingChatWebSocket {
  let inner: ChatWebSocket = createWebSocket()
  let url: string | null = null
  let explicitlyClosed = false
  let reconnecting = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const socket: ReconnectingChatWebSocket = {
    get readyState() {
      return inner.readyState
    },

    onOpen: null,
    onMessage: null,
    onClose: null,
    onError: null,
    onReconnecting: null,
    onReconnected: null,
    onReconnectFailed: null,

    connect(connectUrl: string) {
      url = connectUrl
      explicitlyClosed = false
      attempt = 0
      reconnecting = false
      wireUp(inner)
      inner.connect(connectUrl)
    },

    send(message: ClientMessage) {
      // During reconnection, silently drop messages
      if (reconnecting) return
      inner.send(message)
    },

    close() {
      explicitlyClosed = true
      cancelReconnectTimer()
      inner.close()
    },

    cancelReconnect() {
      explicitlyClosed = true
      cancelReconnectTimer()
    },
  }

  function cancelReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function wireUp(ws: ChatWebSocket) {
    ws.onOpen = () => {
      if (reconnecting) {
        reconnecting = false
        attempt = 0
        socket.onReconnected?.()
      } else {
        socket.onOpen?.()
      }
    }

    ws.onMessage = (msg: ServerMessage | ClientMessage) => {
      socket.onMessage?.(msg)
    }

    ws.onClose = (code: number, reason: string) => {
      if (explicitlyClosed || code === 1000) {
        socket.onClose?.(code, reason)
        return
      }
      tryReconnect()
    }

    ws.onError = (error: unknown) => {
      if (explicitlyClosed) {
        socket.onError?.(error)
        return
      }
      // Don't propagate errors during reconnection —
      // onClose will handle the reconnect attempt
      if (!reconnecting) {
        socket.onError?.(error)
      }
    }
  }

  function tryReconnect() {
    if (explicitlyClosed || !url) return
    if (attempt >= MAX_RETRIES) {
      reconnecting = false
      socket.onReconnectFailed?.()
      return
    }

    if (!reconnecting) {
      reconnecting = true
      socket.onReconnecting?.()
    }

    const delay = backoffDelay(attempt)
    attempt++

    reconnectTimer = setTimeout(() => {
      if (explicitlyClosed || !url) return
      inner = createWebSocket()
      wireUp(inner)
      inner.connect(url)
    }, delay)
  }

  return socket
}
