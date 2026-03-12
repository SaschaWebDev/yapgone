import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useRecentEmojis } from '../../src/hooks/use-recent-emojis'

function renderHook(maxRecent?: number) {
  let current: ReturnType<typeof useRecentEmojis> = {
    recentEmojis: [],
    trackEmoji: () => {},
  }

  function TestComponent() {
    current = useRecentEmojis(maxRecent)
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: ReturnType<typeof createRoot>
  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    get current() { return current },
    cleanup() { act(() => { root.unmount() }); container.remove() },
  }
}

describe('useRecentEmojis', () => {
  it('starts with empty array', () => {
    const hook = renderHook()
    expect(hook.current.recentEmojis).toEqual([])
    hook.cleanup()
  })

  it('adds tracked emoji to front', () => {
    const hook = renderHook()
    act(() => hook.current.trackEmoji('😀'))
    expect(hook.current.recentEmojis).toEqual(['😀'])
    hook.cleanup()
  })

  it('moves repeated emoji to front', () => {
    const hook = renderHook()
    act(() => hook.current.trackEmoji('😀'))
    act(() => hook.current.trackEmoji('😂'))
    act(() => hook.current.trackEmoji('😀'))
    expect(hook.current.recentEmojis).toEqual(['😀', '😂'])
    hook.cleanup()
  })

  it('caps at maxRecent', () => {
    const hook = renderHook(3)
    act(() => hook.current.trackEmoji('😀'))
    act(() => hook.current.trackEmoji('😂'))
    act(() => hook.current.trackEmoji('🔥'))
    act(() => hook.current.trackEmoji('❤️'))
    expect(hook.current.recentEmojis).toEqual(['❤️', '🔥', '😂'])
    hook.cleanup()
  })

  it('deduplicates', () => {
    const hook = renderHook()
    act(() => hook.current.trackEmoji('😀'))
    act(() => hook.current.trackEmoji('😀'))
    act(() => hook.current.trackEmoji('😀'))
    expect(hook.current.recentEmojis).toEqual(['😀'])
    hook.cleanup()
  })

  it('uses default maxRecent of 18', () => {
    const hook = renderHook()
    const emojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗','😙','🥲','😏','😌']
    for (const e of emojis) {
      act(() => hook.current.trackEmoji(e))
    }
    expect(hook.current.recentEmojis).toHaveLength(18)
    expect(hook.current.recentEmojis[0]).toBe('😌')
    hook.cleanup()
  })
})
