import type { ReactNode } from 'react'

export interface Segment {
  type: 'text' | 'bold' | 'italic' | 'bolditalic' | 'link'
  content: string
  href?: string
}

const URL_RE = /https?:\/\/\S+|www\.\S+/g
const BOLD_ITALIC_RE = /\*\*\*([^*\n]+)\*\*\*/g
const BOLD_RE = /\*\*([^*\n]+)\*\*/g
const ITALIC_RE = /(?<!\*)\*([^*\n]+)\*(?!\*)/g

interface Range {
  start: number
  end: number
  type: 'bold' | 'italic' | 'bolditalic' | 'link'
  content: string
  href?: string
}

function overlaps(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some((r) => !(end <= r.start || start >= r.end))
}

export function parseFormattedSegments(text: string): Segment[] {
  if (!text) return [{ type: 'text', content: '' }]

  const ranges: Range[] = []

  // Phase 1: extract URLs
  let match: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((match = URL_RE.exec(text)) !== null) {
    const url = match[0]
    ranges.push({
      start: match.index,
      end: match.index + url.length,
      type: 'link',
      content: url,
      href: url.startsWith('http') ? url : `https://${url}`,
    })
  }

  // Phase 2: parse formatting in non-URL text (priority: bolditalic > bold > italic)
  BOLD_ITALIC_RE.lastIndex = 0
  while ((match = BOLD_ITALIC_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (!overlaps(start, end, ranges)) {
      ranges.push({ start, end, type: 'bolditalic', content: match[1] ?? '' })
    }
  }

  BOLD_RE.lastIndex = 0
  while ((match = BOLD_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (!overlaps(start, end, ranges)) {
      ranges.push({ start, end, type: 'bold', content: match[1] ?? '' })
    }
  }

  ITALIC_RE.lastIndex = 0
  while ((match = ITALIC_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (!overlaps(start, end, ranges)) {
      ranges.push({ start, end, type: 'italic', content: match[1] ?? '' })
    }
  }

  ranges.sort((a, b) => a.start - b.start)

  // Build segments
  const segments: Segment[] = []
  let cursor = 0

  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, range.start) })
    }
    if (range.start >= cursor) {
      const seg: Segment = { type: range.type, content: range.content }
      if (range.href) seg.href = range.href
      segments.push(seg)
      cursor = range.end
    }
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) })
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content: text })
  }

  return segments
}

let keyCounter = 0

export function formatMessage(text: string): ReactNode {
  const segments = parseFormattedSegments(text)

  const first = segments[0]
  if (segments.length === 1 && first && first.type === 'text') {
    return first.content
  }

  return segments.map((seg) => {
    const key = keyCounter++
    switch (seg.type) {
      case 'bold':
        return <strong key={key} className="msgBold">{seg.content}</strong>
      case 'italic':
        return <em key={key} className="msgItalic">{seg.content}</em>
      case 'bolditalic':
        return (
          <strong key={key} className="msgBold">
            <em className="msgItalic">{seg.content}</em>
          </strong>
        )
      case 'link':
        return (
          <a
            key={key}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="messageLink"
            onClick={(e) => e.stopPropagation()}
          >
            {seg.content}
          </a>
        )
      default:
        return <span key={key}>{seg.content}</span>
    }
  })
}
