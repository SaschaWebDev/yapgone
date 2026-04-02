interface PaletteEntry {
  readonly color: string
  readonly pattern: string
  readonly patternSize: string
}

export interface SenderIdentity {
  readonly color: string
  readonly patternCss: string
  readonly patternSize: string
  readonly index: number
}

const W = 'rgba(255,255,255,0.4)'
const T = 'transparent'

const PALETTE: readonly PaletteEntry[] = [
  // 0 — red, diagonal stripes /
  {
    color: '#E25D5D',
    pattern: `repeating-linear-gradient(45deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px)`,
    patternSize: '7px 7px',
  },
  // 1 — orange, arcs (curved brackets)
  {
    color: '#E2915D',
    pattern: `radial-gradient(circle at 0% 50%,${T} 3px,${W} 3px,${W} 5px,${T} 5px),radial-gradient(circle at 100% 50%,${T} 3px,${W} 3px,${W} 5px,${T} 5px)`,
    patternSize: '8px 8px',
  },
  // 2 — gold, vertical stripes
  {
    color: '#D4B035',
    pattern: `repeating-linear-gradient(90deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px)`,
    patternSize: '5px 5px',
  },
  // 3 — lime, dots grid
  {
    color: '#8DC63F',
    pattern: `radial-gradient(circle,${W} 1.5px,${T} 1.5px)`,
    patternSize: '5px 5px',
  },
  // 4 — green, horizontal stripes
  {
    color: '#4CAF50',
    pattern: `repeating-linear-gradient(0deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px)`,
    patternSize: '5px 5px',
  },
  // 5 — mint, crosshatch
  {
    color: '#4DD0A8',
    pattern: `repeating-linear-gradient(45deg,${W} 0px,${W} 1px,${T} 1px,${T} 4px),repeating-linear-gradient(-45deg,${W} 0px,${W} 1px,${T} 1px,${T} 4px)`,
    patternSize: '6px 6px',
  },
  // 6 — teal, diagonal stripes \
  {
    color: '#26A69A',
    pattern: `repeating-linear-gradient(-45deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px)`,
    patternSize: '7px 7px',
  },
  // 7 — sky blue, wide horizontal bands
  {
    color: '#42A5F5',
    pattern: `repeating-linear-gradient(0deg,${W} 0px,${W} 3px,${T} 3px,${T} 7px)`,
    patternSize: '7px 7px',
  },
  // 8 — blue, diamond dots (offset grid)
  {
    color: '#5C6BC0',
    pattern: `radial-gradient(circle,${W} 1.5px,${T} 1.5px),radial-gradient(circle at 3px 3px,${W} 1.5px,${T} 1.5px)`,
    patternSize: '6px 6px',
  },
  // 9 — indigo, checkerboard
  {
    color: '#7E57C2',
    pattern: `linear-gradient(45deg,${W} 25%,${T} 25%,${T} 75%,${W} 75%),linear-gradient(-45deg,${W} 25%,${T} 25%,${T} 75%,${W} 75%)`,
    patternSize: '6px 6px',
  },
  // 10 — purple, dense dots
  {
    color: '#AB47BC',
    pattern: `radial-gradient(circle,${W} 1px,${T} 1px)`,
    patternSize: '3px 3px',
  },
  // 11 — magenta, wide diagonal /
  {
    color: '#E040A0',
    pattern: `repeating-linear-gradient(45deg,${W} 0px,${W} 3px,${T} 3px,${T} 7px)`,
    patternSize: '10px 10px',
  },
  // 12 — pink, fine grid
  {
    color: '#EC407A',
    pattern: `repeating-linear-gradient(0deg,${W} 0px,${W} 1px,${T} 1px,${T} 4px),repeating-linear-gradient(90deg,${W} 0px,${W} 1px,${T} 1px,${T} 4px)`,
    patternSize: '4px 4px',
  },
  // 13 — brown, horizontal dashes
  {
    color: '#A0785D',
    pattern: `repeating-linear-gradient(0deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px),repeating-linear-gradient(90deg,${T} 0px,${T} 4px,rgba(0,0,0,0.15) 4px,rgba(0,0,0,0.15) 8px)`,
    patternSize: '8px 5px',
  },
  // 14 — gray, solid (no pattern)
  {
    color: '#78909C',
    pattern: 'none',
    patternSize: '0',
  },
  // 15 — coral, vertical dashes
  {
    color: '#FF7043',
    pattern: `repeating-linear-gradient(90deg,${W} 0px,${W} 2px,${T} 2px,${T} 5px),repeating-linear-gradient(0deg,${T} 0px,${T} 4px,rgba(0,0,0,0.15) 4px,rgba(0,0,0,0.15) 8px)`,
    patternSize: '5px 8px',
  },
  // 16 — emerald, X-cross
  {
    color: '#2E7D32',
    pattern: `repeating-linear-gradient(45deg,${W} 0px,${W} 1px,${T} 1px,${T} 6px),repeating-linear-gradient(-45deg,${W} 0px,${W} 1px,${T} 1px,${T} 6px)`,
    patternSize: '8px 8px',
  },
  // 17 — steel blue, sparse diagonal \
  {
    color: '#5D9ECC',
    pattern: `repeating-linear-gradient(-45deg,${W} 0px,${W} 2px,${T} 2px,${T} 8px)`,
    patternSize: '11px 11px',
  },
  // 18 — rose, zigzag
  {
    color: '#CC5D8E',
    pattern: `linear-gradient(135deg,${W} 25%,${T} 25%) -3px 0,linear-gradient(225deg,${W} 25%,${T} 25%) -3px 0,linear-gradient(315deg,${W} 25%,${T} 25%),linear-gradient(45deg,${W} 25%,${T} 25%)`,
    patternSize: '6px 6px',
  },
  // 19 — olive, double horizontal stripes
  {
    color: '#9E9E5D',
    pattern: `repeating-linear-gradient(0deg,${W} 0px,${W} 1px,${T} 1px,${T} 3px,${W} 3px,${W} 4px,${T} 4px,${T} 8px)`,
    patternSize: '8px 8px',
  },
] as const

function hash(senderId: string): number {
  let h = 0
  for (let i = 0; i < senderId.length; i++) {
    h = ((h << 5) - h + senderId.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function senderIdentity(senderId: string): SenderIdentity {
  const index = hash(senderId) % PALETTE.length
  const entry = PALETTE[index]
  if (!entry) throw new Error('unreachable')
  return {
    color: entry.color,
    patternCss: entry.pattern,
    patternSize: entry.patternSize,
    index,
  }
}

export function senderColor(senderId: string): string {
  return senderIdentity(senderId).color
}

/**
 * Build a collision-free identity map for a set of sender IDs.
 * Each sender gets a unique palette entry; collisions are resolved
 * by advancing to the next free slot.
 */
export function buildIdentityMap(senderIds: readonly string[]): ReadonlyMap<string, SenderIdentity> {
  const map = new Map<string, SenderIdentity>()
  const taken = new Set<number>()

  for (const id of senderIds) {
    let index = hash(id) % PALETTE.length
    while (taken.has(index)) {
      index = (index + 1) % PALETTE.length
    }
    taken.add(index)
    const entry = PALETTE[index]
    if (!entry) throw new Error('unreachable')
    map.set(id, {
      color: entry.color,
      patternCss: entry.pattern,
      patternSize: entry.patternSize,
      index,
    })
  }

  return map
}
