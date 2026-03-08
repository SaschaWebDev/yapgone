import { describe, it, expect } from 'vitest'
import { _requiresPrivacyGate } from '@/components/ui/voice-controls/VoiceControls'

describe('voice controls privacy gate', () => {
  it('requires gate when privacy is not acknowledged', () => {
    expect(_requiresPrivacyGate(false)).toBe(true)
  })

  it('does not require gate when privacy is acknowledged', () => {
    expect(_requiresPrivacyGate(true)).toBe(false)
  })
})
