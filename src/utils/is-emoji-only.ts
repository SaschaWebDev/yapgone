const EMOJI_RE = /^\p{Emoji_Presentation}$/u

export function isEmojiOnly(text: string): boolean {
  const stripped = text.replace(/\s/g, '')
  if (stripped.length === 0) return false
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const segments = Array.from(segmenter.segment(stripped))
  if (segments.length === 0 || segments.length > 8) return false
  return segments.every(s => EMOJI_RE.test(s.segment))
}
