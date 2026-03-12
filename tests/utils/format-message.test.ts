import { describe, it, expect } from 'vitest'
import { parseFormattedSegments } from '../../src/utils/format-message'

describe('parseFormattedSegments', () => {
  it('returns plain text segment for normal text', () => {
    expect(parseFormattedSegments('hello world')).toEqual([
      { type: 'text', content: 'hello world' },
    ])
  })

  it('parses **bold**', () => {
    expect(parseFormattedSegments('**bold**')).toEqual([
      { type: 'bold', content: 'bold' },
    ])
  })

  it('parses *italic*', () => {
    expect(parseFormattedSegments('*italic*')).toEqual([
      { type: 'italic', content: 'italic' },
    ])
  })

  it('parses ***bold italic***', () => {
    expect(parseFormattedSegments('***bold italic***')).toEqual([
      { type: 'bolditalic', content: 'bold italic' },
    ])
  })

  it('treats unmatched * as literal text', () => {
    expect(parseFormattedSegments('hello * world')).toEqual([
      { type: 'text', content: 'hello * world' },
    ])
  })

  it('treats **unclosed as literal text', () => {
    expect(parseFormattedSegments('**unclosed')).toEqual([
      { type: 'text', content: '**unclosed' },
    ])
  })

  it('treats **** (empty) as literal text', () => {
    expect(parseFormattedSegments('****')).toEqual([
      { type: 'text', content: '****' },
    ])
  })

  it('does not parse formatting markers inside URLs', () => {
    const result = parseFormattedSegments('https://example.com/**bold**')
    expect(result).toEqual([
      { type: 'link', content: 'https://example.com/**bold**', href: 'https://example.com/**bold**' },
    ])
  })

  it('leaves URLs unaffected by surrounding text', () => {
    const result = parseFormattedSegments('check https://example.com please')
    expect(result).toEqual([
      { type: 'text', content: 'check ' },
      { type: 'link', content: 'https://example.com', href: 'https://example.com' },
      { type: 'text', content: ' please' },
    ])
  })

  it('parses multiple formats in one message', () => {
    expect(parseFormattedSegments('**bold** and *italic*')).toEqual([
      { type: 'bold', content: 'bold' },
      { type: 'text', content: ' and ' },
      { type: 'italic', content: 'italic' },
    ])
  })

  it('formatting does not span newlines', () => {
    expect(parseFormattedSegments('*hello\nworld*')).toEqual([
      { type: 'text', content: '*hello\nworld*' },
    ])
  })

  it('handles mixed URLs and formatting', () => {
    expect(parseFormattedSegments('**bold** https://test.com *italic*')).toEqual([
      { type: 'bold', content: 'bold' },
      { type: 'text', content: ' ' },
      { type: 'link', content: 'https://test.com', href: 'https://test.com' },
      { type: 'text', content: ' ' },
      { type: 'italic', content: 'italic' },
    ])
  })

  it('handles www URLs with formatting', () => {
    const result = parseFormattedSegments('visit www.test.com and **read** it')
    expect(result).toEqual([
      { type: 'text', content: 'visit ' },
      { type: 'link', content: 'www.test.com', href: 'https://www.test.com' },
      { type: 'text', content: ' and ' },
      { type: 'bold', content: 'read' },
      { type: 'text', content: ' it' },
    ])
  })

  it('handles empty string', () => {
    expect(parseFormattedSegments('')).toEqual([
      { type: 'text', content: '' },
    ])
  })

  it('treats ** (just two stars) as literal text', () => {
    expect(parseFormattedSegments('**')).toEqual([
      { type: 'text', content: '**' },
    ])
  })

  it('handles bold and bold italic in same message', () => {
    expect(parseFormattedSegments('***both*** then **bold**')).toEqual([
      { type: 'bolditalic', content: 'both' },
      { type: 'text', content: ' then ' },
      { type: 'bold', content: 'bold' },
    ])
  })
})
