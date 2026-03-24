import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { MessageReaction } from '@/hooks/chat-helpers'
import styles from './ReactionDetail.module.css'

interface GroupedReaction {
  emoji: string
  count: number
  reactions: MessageReaction[]
}

function groupReactions(reactions: MessageReaction[]): GroupedReaction[] {
  const map = new Map<string, MessageReaction[]>()
  for (const r of reactions) {
    const list = map.get(r.emoji)
    if (list) {
      list.push(r)
    } else {
      map.set(r.emoji, [r])
    }
  }
  return Array.from(map.entries()).map(([emoji, list]) => ({
    emoji,
    count: list.length,
    reactions: list,
  }))
}

interface ReactionDetailProps {
  reactions: MessageReaction[]
  anchorRect: DOMRect
  alignRight: boolean
  onRemoveReaction: (emoji: string) => void
  onClose: () => void
  resolveReactorName: (reaction: MessageReaction) => string
}

export function ReactionDetail({
  reactions,
  anchorRect,
  alignRight,
  onRemoveReaction,
  onClose,
  resolveReactorName,
}: ReactionDetailProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<string | null>(null)

  const grouped = groupReactions(reactions)

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [handleClickOutside])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Position above anchor by default, flip below if insufficient space
  const minOverlayHeight = 80
  const gap = 16
  const spaceAbove = anchorRect.top - gap
  const placeAbove = spaceAbove >= minOverlayHeight

  const left = alignRight
    ? anchorRect.right
    : anchorRect.left

  const positionStyle: React.CSSProperties = {
    position: 'fixed',
    left,
    transform: alignRight ? 'translateX(-100%)' : undefined,
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + gap }
      : { top: anchorRect.bottom + gap }),
  }

  const filtered = activeTab
    ? reactions.filter(r => r.emoji === activeTab)
    : reactions

  return createPortal(
    <div
      ref={ref}
      className={styles.overlay}
      style={positionStyle}
    >
      <div className={styles.tabBar}>
        <button
          type="button"
          className={`${styles.tab}${activeTab === null ? ` ${styles.tabActive}` : ''}`}
          onClick={() => setActiveTab(null)}
        >
          All {reactions.length}
        </button>
        {grouped.map(g => (
          <button
            key={g.emoji}
            type="button"
            className={`${styles.tab}${activeTab === g.emoji ? ` ${styles.tabActive}` : ''}`}
            onClick={() => setActiveTab(g.emoji)}
          >
            {g.emoji} {g.count}
          </button>
        ))}
      </div>
      <div className={styles.list}>
        {filtered.map((r, i) => {
          const name = resolveReactorName(r)
          const isSelf = r.fromSelf
          return (
            <div
              key={`${r.emoji}-${r.senderId ?? (r.fromSelf ? 'self' : 'peer')}-${i}`}
              className={`${styles.row}${isSelf ? ` ${styles.rowSelf}` : ''}`}
              onClick={isSelf ? () => onRemoveReaction(r.emoji) : undefined}
              role={isSelf ? 'button' : undefined}
            >
              <div className={styles.rowLeft}>
                <span className={styles.rowName}>{name}</span>
                {isSelf && <span className={styles.rowHint}>Click to remove</span>}
              </div>
              <span className={styles.rowEmoji}>{r.emoji}</span>
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
