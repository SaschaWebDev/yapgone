import { describe, expect, it } from 'vitest'
import { hkdfDerive, hmacSign, kdfRatchetStep } from '@/crypto'

describe('HKDF', () => {
  it('derives a 32-byte key', async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32))
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const info = new TextEncoder().encode('test-info')

    const derived = await hkdfDerive(ikm, salt, info, 32)
    expect(derived.length).toBe(32)
  })

  it('is deterministic with same inputs', async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32))
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const info = new TextEncoder().encode('test')

    const a = await hkdfDerive(ikm, salt, info, 32)
    const b = await hkdfDerive(ikm, salt, info, 32)
    expect(a).toEqual(b)
  })

  it('produces different output with different salt', async () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32))
    const info = new TextEncoder().encode('test')

    const a = await hkdfDerive(ikm, new Uint8Array(32), info, 32)
    const b = await hkdfDerive(ikm, crypto.getRandomValues(new Uint8Array(32)), info, 32)
    expect(a).not.toEqual(b)
  })
})

describe('HMAC', () => {
  it('is deterministic', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const data = new TextEncoder().encode('hello')

    const a = await hmacSign(key, data)
    const b = await hmacSign(key, data)
    expect(a).toEqual(b)
  })

  it('produces 32-byte output', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const data = new TextEncoder().encode('test')

    const sig = await hmacSign(key, data)
    expect(sig.length).toBe(32)
  })
})

describe('kdfRatchetStep', () => {
  it('produces distinct nextChainKey and messageKey', async () => {
    const chainKey = crypto.getRandomValues(new Uint8Array(32))

    const { nextChainKey, messageKey } = await kdfRatchetStep(chainKey)

    expect(nextChainKey.length).toBe(32)
    expect(messageKey.length).toBe(32)
    expect(nextChainKey).not.toEqual(messageKey)
    expect(nextChainKey).not.toEqual(chainKey)
  })

  it('is deterministic', async () => {
    const chainKey = crypto.getRandomValues(new Uint8Array(32))

    const a = await kdfRatchetStep(chainKey)
    const b = await kdfRatchetStep(chainKey)

    expect(a.nextChainKey).toEqual(b.nextChainKey)
    expect(a.messageKey).toEqual(b.messageKey)
  })

  it('chains produce advancing keys', async () => {
    const ck0 = crypto.getRandomValues(new Uint8Array(32))

    const step1 = await kdfRatchetStep(ck0)
    const step2 = await kdfRatchetStep(step1.nextChainKey)

    expect(step1.messageKey).not.toEqual(step2.messageKey)
    expect(step1.nextChainKey).not.toEqual(step2.nextChainKey)
  })
})
