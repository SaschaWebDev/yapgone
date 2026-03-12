import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useInactivityTimer } from '../../src/hooks/use-inactivity-timer'

/**
 * Tiny test harness that renders a component using the hook
 * and exposes the latest return value, avoiding @testing-library/react.
 */
function renderHook(ttlMs: number) {
  let current: ReturnType<typeof useInactivityTimer> = {
    remainingSeconds: 0,
    resetTimer: () => {},
  }

  function TestComponent() {
    current = useInactivityTimer(ttlMs)
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(createElement(TestComponent))
  })

  return {
    get result() {
      return current
    },
    unmount() {
      act(() => {
        root.unmount()
      })
      document.body.removeChild(container)
    },
  }
}

describe('useInactivityTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with full TTL in seconds', () => {
    const hook = renderHook(30 * 60 * 1000)
    expect(hook.result.remainingSeconds).toBe(1800)
    hook.unmount()
  })

  it('counts down over time', () => {
    const hook = renderHook(60_000)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(hook.result.remainingSeconds).toBe(50)
    hook.unmount()
  })

  it('never goes below zero', () => {
    const hook = renderHook(5_000)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(hook.result.remainingSeconds).toBe(0)
    hook.unmount()
  })

  it('resets to full TTL on resetTimer()', () => {
    const hook = renderHook(60_000)

    act(() => {
      vi.advanceTimersByTime(30_000)
    })

    expect(hook.result.remainingSeconds).toBe(30)

    act(() => {
      hook.result.resetTimer()
    })

    // After reset, next tick recalculates from Date.now()
    // 1s has elapsed since reset, so remaining = 59
    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(hook.result.remainingSeconds).toBe(59)
    hook.unmount()
  })

  it('cleans up interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const hook = renderHook(60_000)
    hook.unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
