import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { VOICE_WAVEFORM_BAR_COUNT } from '@/constants'
import styles from './VoiceControls.module.css'

interface AudioWaveformProps {
  analyserRef: RefObject<AnalyserNode | null>
  barCount?: number
  muted?: boolean
}

export function AudioWaveform({
  analyserRef,
  barCount = VOICE_WAVEFORM_BAR_COUNT,
  muted = false,
}: AudioWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<HTMLDivElement[]>([])
  const rafRef = useRef(0)
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  // Update bar colors when muted state changes
  useEffect(() => {
    for (const bar of barRefs.current) {
      bar.className = muted ? styles.waveformBarMuted! : styles.waveformBar!
    }
  }, [muted])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Create bar elements
    container.innerHTML = ''
    barRefs.current = []
    for (let i = 0; i < barCount; i++) {
      const bar = document.createElement('div')
      bar.className = muted ? styles.waveformBarMuted! : styles.waveformBar!
      bar.style.height = '3px'
      container.appendChild(bar)
      barRefs.current.push(bar)
    }

    const dataArray = new Uint8Array(128) // frequencyBinCount for fftSize=256

    const tick = () => {
      const analyser = analyserRef.current
      if (analyser && !mutedRef.current) {
        analyser.getByteFrequencyData(dataArray)
        const binsPerBar = Math.floor(dataArray.length / barCount)

        for (let i = 0; i < barCount; i++) {
          let sum = 0
          for (let j = 0; j < binsPerBar; j++) {
            sum += dataArray[i * binsPerBar + j]!
          }
          const avg = sum / binsPerBar
          // Scale 0-255 to 3px-24px (within 1.875rem ≈ 30px container)
          const height = Math.max(3, (avg / 255) * 24)
          barRefs.current[i]!.style.height = `${height}px`
        }
      } else {
        // Muted or no analyser — flatten bars
        for (let i = 0; i < barCount; i++) {
          barRefs.current[i]!.style.height = '3px'
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [analyserRef, barCount]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className={styles.waveformInline} />
}
