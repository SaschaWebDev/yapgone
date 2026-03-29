import { useEffect, useRef, useState } from 'react'
import {
  VOICE_VAD_THRESHOLD,
  VOICE_VAD_HOLD_MS,
  VOICE_ANALYSER_FFT_SIZE,
  VOICE_ANALYSER_SMOOTHING,
} from '@/constants'

interface UseAudioAnalyserReturn {
  analyserRef: React.RefObject<AnalyserNode | null>
  isSpeaking: boolean
}

export function useAudioAnalyser(
  stream: MediaStream | null,
  vadThreshold = VOICE_VAD_THRESHOLD,
): UseAudioAnalyserReturn {
  const analyserRef = useRef<AnalyserNode | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)

  useEffect(() => {
    if (!stream || !stream.active) {
      analyserRef.current = null
      setIsSpeaking(false)
      return
    }

    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch {
      return
    }

    let source: MediaStreamAudioSourceNode
    try {
      source = ctx.createMediaStreamSource(stream)
    } catch {
      void ctx.close()
      return
    }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = VOICE_ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = VOICE_ANALYSER_SMOOTHING
    source.connect(analyser)
    analyserRef.current = analyser

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let rafId = 0
    let holdTimeout: ReturnType<typeof setTimeout> | null = null
    let currentlySpeaking = false

    const tick = () => {
      analyser.getByteFrequencyData(dataArray)

      // Compute RMS
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]! * dataArray[i]!
      }
      const rms = Math.sqrt(sum / dataArray.length)

      if (rms > vadThreshold) {
        if (holdTimeout) {
          clearTimeout(holdTimeout)
          holdTimeout = null
        }
        if (!currentlySpeaking) {
          currentlySpeaking = true
          setIsSpeaking(true)
        }
      } else if (currentlySpeaking && !holdTimeout) {
        holdTimeout = setTimeout(() => {
          currentlySpeaking = false
          setIsSpeaking(false)
          holdTimeout = null
        }, VOICE_VAD_HOLD_MS)
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      if (holdTimeout) clearTimeout(holdTimeout)
      analyserRef.current = null
      source.disconnect()
      void ctx.close()
      setIsSpeaking(false)
    }
  }, [stream, vadThreshold])

  return { analyserRef, isSpeaking }
}
