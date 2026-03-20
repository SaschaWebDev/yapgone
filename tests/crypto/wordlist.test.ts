import { describe, it, expect } from 'vitest'
import { WORDLIST, generateSafeWord } from '../../src/crypto/wordlist'

describe('WORDLIST', () => {
  it('contains exactly 2048 entries', () => {
    expect(WORDLIST.length).toBe(2048)
  })

  it('contains only lowercase alphabetic strings', () => {
    for (const word of WORDLIST) {
      expect(word).toMatch(/^[a-z]+$/)
    }
  })
})

describe('generateSafeWord', () => {
  it('returns two words joined by a dash', () => {
    const result = generateSafeWord()
    const parts = result.split('-')
    expect(parts.length).toBe(2)
    expect(parts[0]!.length).toBeGreaterThan(0)
    expect(parts[1]!.length).toBeGreaterThan(0)
  })

  it('uses words from the wordlist', () => {
    const result = generateSafeWord()
    const [w1, w2] = result.split('-')
    expect(WORDLIST).toContain(w1)
    expect(WORDLIST).toContain(w2)
  })

  it('produces different results across calls', () => {
    const results = new Set(Array.from({ length: 20 }, () => generateSafeWord()))
    expect(results.size).toBeGreaterThan(1)
  })
})
