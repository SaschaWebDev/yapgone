import { describe, expect, it } from 'vitest'
import { xorSplit, xorCombine, toBase64Url, fromBase64Url, concatBytes } from '@/crypto'

describe('XOR split/combine', () => {
  it('round-trips data', () => {
    const data = crypto.getRandomValues(new Uint8Array(65))
    const { share1, share2 } = xorSplit(data)
    const reconstructed = xorCombine(share1, share2)
    expect(reconstructed).toEqual(data)
  })

  it('shares are different from original', () => {
    const data = new Uint8Array(32).fill(0xab)
    const { share1, share2 } = xorSplit(data)
    // Extremely unlikely both shares equal the original
    const share1Match = share1.every((b, i) => b === (data[i] ?? 0))
    const share2Match = share2.every((b, i) => b === (data[i] ?? 0))
    expect(share1Match && share2Match).toBe(false)
  })

  it('throws on mismatched lengths', () => {
    expect(() =>
      xorCombine(new Uint8Array(16), new Uint8Array(32))
    ).toThrow('Shares must have equal length')
  })

  it('works with empty arrays', () => {
    const data = new Uint8Array(0)
    const { share1, share2 } = xorSplit(data)
    const reconstructed = xorCombine(share1, share2)
    expect(reconstructed).toEqual(data)
  })
})

describe('base64url encoding', () => {
  it('round-trips binary data', () => {
    const data = crypto.getRandomValues(new Uint8Array(65))
    const encoded = toBase64Url(data)
    const decoded = fromBase64Url(encoded)
    expect(decoded).toEqual(data)
  })

  it('round-trips small data', () => {
    const data = new Uint8Array([0, 1, 2])
    const encoded = toBase64Url(data)
    const decoded = fromBase64Url(encoded)
    expect(decoded).toEqual(data)
  })

  it('produces URL-safe characters only', () => {
    const data = crypto.getRandomValues(new Uint8Array(100))
    const encoded = toBase64Url(data)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/)
  })

  it('round-trips single byte', () => {
    const data = new Uint8Array([255])
    const encoded = toBase64Url(data)
    const decoded = fromBase64Url(encoded)
    expect(decoded).toEqual(data)
  })
})

describe('concatBytes', () => {
  it('concatenates multiple arrays', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array([3, 4, 5])
    const c = new Uint8Array([6])
    const result = concatBytes(a, b, c)
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
  })

  it('handles empty arrays', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array(0)
    const result = concatBytes(a, b)
    expect(result).toEqual(new Uint8Array([1, 2]))
  })

  it('handles no arguments', () => {
    const result = concatBytes()
    expect(result).toEqual(new Uint8Array(0))
  })
})
