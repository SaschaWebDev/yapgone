import type { ReactNode } from 'react'

const URL_RE = /https?:\/\/\S+|www\.\S+/g

export function linkify(text: string): ReactNode {
  const matches = [...text.matchAll(URL_RE)]
  if (matches.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0

  for (const match of matches) {
    const start = match.index
    const url = match[0]

    if (start > cursor) {
      parts.push(text.slice(cursor, start))
    }

    const href = url.startsWith('http') ? url : `https://${url}`
    parts.push(
      <a
        key={start}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="messageLink"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>,
    )

    cursor = start + url.length
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return parts
}
