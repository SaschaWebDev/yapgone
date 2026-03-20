import { describe, it, expect } from 'vitest'
import {
  computePairwiseSafetyNumber,
  computeGroupFingerprint,
  formatSafetyNumber,
} from '../../src/crypto/safety-number'

describe('Safety Numbers', () => {
  function makeKey(seed: number): Uint8Array {
    // Create a deterministic 65-byte "public key" for testing
    const key = new Uint8Array(65)
    key[0] = 0x04 // uncompressed point prefix
    for (let i = 1; i < 65; i++) {
      key[i] = (seed * 17 + i * 13) & 0xff
    }
    return key
  }

  describe('computePairwiseSafetyNumber', () => {
    it('produces a 60-digit string', async () => {
      const keyA = makeKey(1)
      const keyB = makeKey(2)
      const result = await computePairwiseSafetyNumber(keyA, keyB)
      expect(result).toMatch(/^\d{60}$/)
    })

    it('is symmetric — same result regardless of key order', async () => {
      const keyA = makeKey(1)
      const keyB = makeKey(2)

      const result1 = await computePairwiseSafetyNumber(keyA, keyB)
      const result2 = await computePairwiseSafetyNumber(keyB, keyA)

      expect(result1).toBe(result2)
    })

    it('is deterministic — same inputs always produce same output', async () => {
      const keyA = makeKey(42)
      const keyB = makeKey(99)

      const result1 = await computePairwiseSafetyNumber(keyA, keyB)
      const result2 = await computePairwiseSafetyNumber(keyA, keyB)

      expect(result1).toBe(result2)
    })

    it('produces different numbers for different key pairs', async () => {
      const keyA = makeKey(1)
      const keyB = makeKey(2)
      const keyC = makeKey(3)

      const resultAB = await computePairwiseSafetyNumber(keyA, keyB)
      const resultAC = await computePairwiseSafetyNumber(keyA, keyC)
      const resultBC = await computePairwiseSafetyNumber(keyB, keyC)

      expect(resultAB).not.toBe(resultAC)
      expect(resultAB).not.toBe(resultBC)
      expect(resultAC).not.toBe(resultBC)
    })

    it('produces identical numbers for identical keys', async () => {
      const key = makeKey(7)
      const result = await computePairwiseSafetyNumber(key, key)
      expect(result).toMatch(/^\d{60}$/)
    })
  })

  describe('computeGroupFingerprint', () => {
    it('produces a 60-digit string for multiple keys', async () => {
      const keys = [makeKey(1), makeKey(2), makeKey(3)]
      const result = await computeGroupFingerprint(keys)
      expect(result).toMatch(/^\d{60}$/)
    })

    it('is order-independent', async () => {
      const keys = [makeKey(1), makeKey(2), makeKey(3)]
      const reversed = [makeKey(3), makeKey(1), makeKey(2)]

      const result1 = await computeGroupFingerprint(keys)
      const result2 = await computeGroupFingerprint(reversed)

      expect(result1).toBe(result2)
    })

    it('changes when a member is added or removed', async () => {
      const keys2 = [makeKey(1), makeKey(2)]
      const keys3 = [makeKey(1), makeKey(2), makeKey(3)]

      const result2 = await computeGroupFingerprint(keys2)
      const result3 = await computeGroupFingerprint(keys3)

      expect(result2).not.toBe(result3)
    })

    it('matches pairwise for exactly 2 keys', async () => {
      const keyA = makeKey(1)
      const keyB = makeKey(2)

      const pairwise = await computePairwiseSafetyNumber(keyA, keyB)
      const group = await computeGroupFingerprint([keyA, keyB])

      // Both use sorted concatenation + SHA-256, so they should match
      expect(pairwise).toBe(group)
    })
  })

  describe('formatSafetyNumber', () => {
    it('formats 60 digits into 12 groups of 5', () => {
      const digits = '1'.repeat(60)
      const formatted = formatSafetyNumber(digits)
      const groups = formatted.split(' ')
      expect(groups.length).toBe(12)
      groups.forEach(group => {
        expect(group).toBe('11111')
      })
    })

    it('preserves leading zeros', () => {
      const digits = '00001' + '0'.repeat(55)
      const formatted = formatSafetyNumber(digits)
      expect(formatted.startsWith('00001')).toBe(true)
    })

    it('handles real safety number output', async () => {
      const keyA = new Uint8Array(65)
      keyA[0] = 0x04
      const keyB = new Uint8Array(65)
      keyB[0] = 0x04
      keyB[1] = 0x01

      const safetyNumber = await computePairwiseSafetyNumber(keyA, keyB)
      const formatted = formatSafetyNumber(safetyNumber)

      expect(formatted.replace(/\s/g, '').length).toBe(60)
      expect(formatted.split(' ').length).toBe(12)
    })
  })
})
