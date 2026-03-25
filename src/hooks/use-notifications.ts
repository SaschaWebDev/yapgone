import { useEffect, useRef } from 'react'
import type { ChatMessage } from './use-chat'
import { DEFAULT_TITLE } from '@/constants'

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext()
  }
  return audioCtx
}

export function unlockAudio(): void {
  try {
    const ctx = getAudioContext()
    void ctx.resume()
  } catch {
    // Web Audio unavailable — silently skip
  }
}

function playTone(frequency: number, duration: number, volume: number) {
  try {
    const ctx = getAudioContext()
    void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = frequency
    osc.type = 'sine'
    gain.gain.setValueAtTime(volume, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + duration)
  } catch {
    // Web Audio unavailable — silently skip
  }
}

export function playSendSound() {
  playTone(880, 0.05, 0.15)
}

function playReceiveSound() {
  playTone(660, 0.07, 0.12)
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

    // Sound plays regardless of tab visibility
    if (soundEnabled) {
      playReceiveSound()
    }

    // Title badge + browser notification only when tab is hidden
    if (!document.hidden) return

    hiddenCountRef.current += peerMessages.length
    document.title = `(${hiddenCountRef.current}) ${DEFAULT_TITLE}`

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
