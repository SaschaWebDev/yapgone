import { useEffect, useRef } from 'react'
import type { ChatMessage } from './use-chat'
import { DEFAULT_TITLE } from '@/constants'

function playBlip() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    osc.type = 'sine'
    gain.gain.setValueAtTime(0.15, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.05)
    osc.onended = () => ctx.close()
  } catch {
    // Web Audio unavailable — silently skip
  }
}

export function useNotifications(
  messages: ChatMessage[],
  phase: string,
  soundEnabled: boolean,
): void {
  const hiddenCountRef = useRef(0)
  const prevLengthRef = useRef(messages.length)

  // Track new peer messages while tab is hidden
  useEffect(() => {
    if (phase !== 'ready') return

    const newMessages = messages.slice(prevLengthRef.current)
    prevLengthRef.current = messages.length

    const peerMessages = newMessages.filter((m) => m.sender === 'peer')
    if (peerMessages.length === 0) return
    if (!document.hidden) return

    hiddenCountRef.current += peerMessages.length
    document.title = `(${hiddenCountRef.current}) ${DEFAULT_TITLE}`

    if (!soundEnabled) return

    playBlip()

    if (Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    if (Notification.permission === 'granted') {
      const n = new Notification(DEFAULT_TITLE, { body: 'New message', tag: 'yapgone-msg' })
      setTimeout(() => n.close(), 4000)
    }
  }, [messages.length, phase, soundEnabled])

  // Reset on focus
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        hiddenCountRef.current = 0
        document.title = DEFAULT_TITLE
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      document.title = DEFAULT_TITLE
    }
  }, [])
}
