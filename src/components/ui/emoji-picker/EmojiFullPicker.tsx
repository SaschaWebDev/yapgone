import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { EMOJI_CATEGORIES, ALL_EMOJIS } from '@/data/emoji-data'
import styles from './EmojiFullPicker.module.css'

interface EmojiFullPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  recentEmojis: readonly string[]
  anchorRect: DOMRect
  alignRight?: boolean
}

export function EmojiFullPicker({ onSelect, onClose, recentEmojis, anchorRect, alignRight }: EmojiFullPickerProps) {
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState(recentEmojis.length > 0 ? 'recent' : EMOJI_CATEGORIES[0]?.id ?? '')
  const gridRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search)
    }, 150)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const filtered = useMemo(() => {
    if (!debouncedSearch) return null
    const q = debouncedSearch.toLowerCase()
    return ALL_EMOJIS.filter(e =>
      e.keywords.some(k => k.includes(q))
    )
  }, [debouncedSearch])

  const scrollToCategory = useCallback((id: string) => {
    setActiveTab(id)
    const el = sectionRefs.current.get(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleGridScroll = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return
    const scrollTop = grid.scrollTop
    let closest = ''
    let closestDist = Infinity
    for (const [id, el] of sectionRefs.current) {
      const dist = Math.abs(el.offsetTop - scrollTop - grid.offsetTop)
      if (dist < closestDist) {
        closestDist = dist
        closest = id
      }
    }
    if (closest && closest !== activeTab) setActiveTab(closest)
  }, [activeTab])

  // Calculate position
  const pickerHeight = 352 // max-height 22rem ≈ 352px
  const pickerWidth = 320  // 20rem
  const spaceBelow = window.innerHeight - anchorRect.bottom - 8
  const spaceAbove = anchorRect.top - 8
  const placeAbove = spaceBelow < pickerHeight && spaceAbove > spaceBelow

  const top = placeAbove
    ? Math.max(8, anchorRect.top - pickerHeight - 4)
    : anchorRect.bottom + 4
  const left = alignRight
    ? Math.max(8, Math.min(anchorRect.right - pickerWidth, window.innerWidth - pickerWidth - 8))
    : Math.max(8, Math.min(anchorRect.left, window.innerWidth - pickerWidth - 8))

  const showRecent = recentEmojis.length > 0 && !filtered
  const allTabs = showRecent
    ? [{ id: 'recent', label: 'Recent', icon: '🕐' }, ...EMOJI_CATEGORIES]
    : [...EMOJI_CATEGORIES]

  return createPortal(
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div
        ref={pickerRef}
        className={styles.picker}
        style={{ top, left }}
      >
        <div className={styles.searchWrapper}>
          <input
            ref={searchRef}
            className={styles.searchInput}
            type="text"
            placeholder="Search emoji..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {!filtered && (
          <div className={styles.tabs}>
            {allTabs.map(t => (
              <button
                key={t.id}
                type="button"
                className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
                onClick={() => scrollToCategory(t.id)}
                title={t.label}
              >
                {t.icon}
              </button>
            ))}
          </div>
        )}

        <div ref={gridRef} className={styles.grid} onScroll={handleGridScroll}>
          {filtered ? (
            filtered.length > 0 ? (
              <div className={styles.emojiGrid}>
                {filtered.map(e => (
                  <button
                    key={e.emoji}
                    type="button"
                    className={styles.emojiButton}
                    onClick={() => onSelect(e.emoji)}
                  >
                    {e.emoji}
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>No emojis found</div>
            )
          ) : (
            <>
              {showRecent && (
                <div ref={el => { if (el) sectionRefs.current.set('recent', el) }}>
                  <div className={styles.categoryLabel}>Recent</div>
                  <div className={styles.emojiGrid}>
                    {recentEmojis.map(emoji => (
                      <button
                        key={emoji}
                        type="button"
                        className={styles.emojiButton}
                        onClick={() => onSelect(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {EMOJI_CATEGORIES.map(cat => (
                <div key={cat.id} ref={el => { if (el) sectionRefs.current.set(cat.id, el) }}>
                  <div className={styles.categoryLabel}>{cat.label}</div>
                  <div className={styles.emojiGrid}>
                    {cat.emojis.map(e => (
                      <button
                        key={e.emoji}
                        type="button"
                        className={styles.emojiButton}
                        onClick={() => onSelect(e.emoji)}
                      >
                        {e.emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}
