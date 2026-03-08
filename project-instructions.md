# yapgone — Claude Code Project Instructions

> Bootstrap conventions distilled from the notefade codebase. A fresh Claude Code instance should be able to scaffold this project from these instructions alone.

---

## Architecture

- **Frontend:** React 19 + TypeScript + Vite. Static SPA hosted on Cloudflare Pages.
- **Backend:** Cloudflare Worker + KV (or D1). Minimal API surface.
- **Package manager:** yarn
- **No SSR.** No Next.js. No server-side rendering. Fully client-side SPA.

---

## 1. Directory Structure

```
/src
  /api                  → Client-side fetch calls to Worker
    /adapters           → Backend adapter implementations (one per provider)
    index.ts            → Barrel: functions + type re-exports
  /components
    /layout             → Page layout wrappers (Layout.tsx, Layout.module.css)
    /ui                 → Reusable presentational components
      /icons            → SVG icon components (one file per icon)
        types.ts        → IconProps interface
        index.ts        → Barrel: all icons + IconProps type
      /[component]/     → ComponentName.tsx + ComponentName.module.css + index.ts
    /docs               → Documentation-specific components (if needed)
    index.ts            → Barrel: re-exports from layout/, ui/
  /constants
    index.ts            → All app constants, `as const` objects
  /crypto               → Crypto operations (Web Crypto API only, zero deps)
    index.ts            → Barrel: all crypto functions + types
  /hooks                → Custom React hooks (one file per hook)
    index.ts            → Barrel: hooks + type re-exports
  /pages                → Page-level components (one directory per route)
    /[page-name]/       → PageName.tsx + PageName.module.css + index.ts
    index.ts            → Barrel: all page exports
  /styles
    variables.css       → CSS custom properties (:root dark default, [data-theme="light"] overrides)
    global.css          → Reset, base typography, focus rings, selection highlight
    animations.css      → Reusable @keyframes
  /utils                → Pure utility functions (one file per category)
    index.ts            → Barrel: wildcard re-exports from each util file
  App.tsx               → Root component with routing logic
  main.tsx              → Vite entry point (renders App into #root)
  vite-env.d.ts         → Vite type definitions

/worker                 → Cloudflare Worker (separate tsconfig)
  index.ts              → Worker entry point (request handler)
  tsconfig.json         → Worker-specific TS config (includes @cloudflare/workers-types)

/tests                  → Unit tests (mirrors src/ structure, NOT colocated)
  /api                  → Tests for src/api/
  /crypto               → Tests for src/crypto/
  /hooks                → Tests for src/hooks/
  /utils                → Tests for src/utils/
  /worker               → Tests for worker/

/e2e                    → End-to-end tests (Playwright)
  *.spec.ts

/public                 → Static assets served by Cloudflare Pages
  favicon.svg
  apple-touch-icon.png
  icon-192.png          → PWA icon
  icon-512.png          → PWA icon
  manifest.json         → PWA manifest
  og-image.png          → OpenGraph preview (1200×630)
  robots.txt
  sitemap.xml
  _headers              → Cloudflare Pages headers
  _redirects            → Cloudflare Pages redirects

/scripts                → Build and utility scripts
/.devcontainer          → Dev container config (Node 22)
/.github/workflows      → CI/CD (build.yml, test.yml)
```

---

## 2. Naming Conventions

| What | Convention | Example |
|---|---|---|
| Files (non-component) | `kebab-case.ts` | `shard-api.ts`, `use-hash-route.ts`, `adapter-factory.ts` |
| Component files | `PascalCase.tsx` | `CreateNote.tsx`, `Layout.tsx` |
| Component directories | `kebab-case/` | `src/pages/create-note/`, `src/components/ui/meta-pill/` |
| CSS Modules | `ComponentName.module.css` | `CreateNote.module.css`, `Layout.module.css` |
| CSS class names in JSX | `camelCase` via styles object | `styles.pillIcon`, `styles.fadeWrapper` |
| Icon files | `icon-{name}.tsx` | `icon-check.tsx`, `icon-clipboard.tsx` |
| Icon exports | `Icon{Name}` | `IconCheck`, `IconClipboard`, `IconFade` |
| Hook files | `use-{name}.ts` | `use-theme.ts`, `use-create-note.ts` |
| Hook exports | `use{Name}` | `useTheme`, `useCreateNote` |
| Test files (unit) | `{module}.test.ts` | `crypto.test.ts`, `shard-api.test.ts` |
| Test files (e2e) | `{feature}.spec.ts` | `create-note.spec.ts`, `routing.spec.ts` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_NOTE_CHARS`, `COPY_FEEDBACK_MS` |

---

## 3. Barrel Export Pattern

Every directory gets an `index.ts`. All exports are **named** — no default exports.

### Pages / Components (single component per directory)
```typescript
// src/pages/create-note/index.ts
export { CreateNote } from './CreateNote'
```

### UI components barrel
```typescript
// src/components/ui/index.ts
export { ContentFade } from './content-fade'
export * from './icons'
export { MetaPill } from './meta-pill'
export { NoteMarkdown, hasMarkdownPatterns } from './note-markdown'
```

### Hooks barrel (functions + types)
```typescript
// src/hooks/index.ts
export { useHashRoute, parseFragment } from './use-hash-route'
export { useCreateNote } from './use-create-note'
export { useTheme } from './use-theme'

export type { HashRoute, ParsedFragment, ReadState } from './use-hash-route'
export type { TTLOption } from './use-create-note'
```

### Utils barrel (wildcard re-exports)
```typescript
// src/utils/index.ts
export * from './random'
export * from './time'
export * from './zip'
```

### API barrel (functions + type-only exports)
```typescript
// src/api/index.ts
export { storeShard, fetchShard, checkShard } from './shard-api'
export { createAdapter } from './adapter-factory'
export { generateShardId } from './shard-id'

export type { ShardStore, ProviderConfig } from './provider-types'
```

### Top-level components barrel
```typescript
// src/components/index.ts
export { Layout } from './layout'
export { ContentFade, MetaPill, NoteMarkdown, QrCode } from './ui'
```

---

## 4. Component Architecture

### Pure function components only. No class components.

```typescript
// src/pages/create-note/CreateNote.tsx
import { useState, useCallback, useRef } from 'react'
import { useCreateNote } from '@/hooks'
import styles from './CreateNote.module.css'

interface CreateNoteProps {
  onNoteCreated?: (hasUrl: boolean) => void
}

export function CreateNote({ onNoteCreated }: CreateNoteProps) {
  const { message, setMessage, noteUrl } = useCreateNote()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    // ...
    onNoteCreated?.(true)
  }, [onNoteCreated])

  return (
    <div className={styles.wrapper}>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <button className={styles.submitButton} onClick={handleSubmit}>
        Create Note
      </button>
    </div>
  )
}
```

### Key patterns:
- **Props:** Destructured from a named interface
- **CSS Modules:** `import styles from './ComponentName.module.css'` — use `styles.className`
- **useCallback:** For event handlers passed to children or used in dependency arrays
- **useRef:** For DOM refs typed generically (`useRef<HTMLTextAreaElement>(null)`)
- **Conditional rendering:** Template literals for class composition, ternary for simple conditions, `&&` for optional content
- **No external UI libraries.** No Material-UI, Chakra, Ant Design, etc.

### Page-level SEO via useEffect
```typescript
useEffect(() => {
  document.title = 'Page Title — yapgone'
  const meta = document.querySelector('meta[name="description"]')
  const prev = meta?.getAttribute('content') ?? ''
  if (meta) {
    meta.setAttribute('content', 'Page-specific description here.')
  }
  return () => {
    document.title = 'yapgone — Default Title'
    if (meta) meta.setAttribute('content', prev)
  }
}, [])
```
No external head management library — pure DOM manipulation with cleanup.

---

## 5. Icon System

### Type definition
```typescript
// src/components/ui/icons/types.ts
import type { SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}
```

### One file per icon
```typescript
// src/components/ui/icons/icon-check.tsx
import type { IconProps } from './types'

export function IconCheck({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" {...props}>
      <path d="..." stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
```

### Conventions:
- Default `size` prop (typically 14, 16, or 20)
- `fill="none"`, stroke-based SVGs
- `currentColor` for theme-aware coloring (or hardcoded for semantic colors like `#22c55e` for success)
- `...props` spread on `<svg>` for `className`, `aria-label`, etc.
- Barrel export from `icons/index.ts` exports `IconProps` type + all icon components

---

## 6. Theming (CSS Custom Properties)

### Dark theme is default. Light theme via `[data-theme="light"]` override.

```css
/* src/styles/variables.css */
:root {
  /* RGB channel values — use with rgba() for flexible opacity */
  --fg: 255, 255, 255;
  --accent-rgb: 99, 102, 241;
  --success-rgb: 34, 197, 94;
  --warning-rgb: 234, 179, 8;
  --error-rgb: 239, 68, 68;

  /* Solid backgrounds */
  --bg-root: #0a0a0a;
  --bg-page: #111111;
  --bg-card: #1a1a1a;
  --bg-elevated: #222222;
  --bg-overlay: rgba(0, 0, 0, 0.7);
  --bg-code: #1e1e1e;

  /* Text */
  --text-primary: rgba(var(--fg), 0.92);
  --text-secondary: rgba(var(--fg), 0.55);

  /* Accent & status */
  --accent: rgb(var(--accent-rgb));
  --accent-hover: /* slightly brighter */;
  --success: rgb(var(--success-rgb));
  --warning: rgb(var(--warning-rgb));
  --error: rgb(var(--error-rgb));
  --link: /* link color */;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
}

[data-theme="light"] {
  --fg: 0, 0, 0;
  --bg-root: #ffffff;
  --bg-page: #fafafa;
  --bg-card: #f5f5f5;
  /* ... override all dark values */
}
```

### Theme toggle hook
```typescript
// src/hooks/use-theme.ts
export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    // Check localStorage, then system preference
  })

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem(STORAGE_KEYS.THEME, next)
    document.documentElement.setAttribute('data-theme', next)
  }, [theme])

  return { theme, toggleTheme } as const
}
```

---

## 7. State Management

- **No Redux, Zustand, or external state libraries.** React hooks only.
- One file per hook in `src/hooks/`.
- Hooks return objects with descriptive property names.
- Type exports alongside hook exports in barrel files.
- `useCallback` for all handler functions that are passed down or in dependency arrays.
- `useRef` for values that must survive re-renders but shouldn't trigger them (promise refs, phase refs, timer IDs).
- Proper cleanup in every `useEffect` (clear timeouts, disconnect observers, restore DOM state).

---

## 8. Constants & Utils

### Constants
```typescript
// src/constants/index.ts
export const MAX_MESSAGE_LENGTH = 2000
export const COPY_FEEDBACK_MS = 1500

export const STORAGE_KEYS = {
  THEME: 'yapgone-theme',
  // ...
} as const

export const VALID_TTLS = [300, 3600, 86400, 604800] as const
```
Use `as const` for literal type inference. Group logically. Single file unless it grows large.

### Utils
```typescript
// src/utils/random.ts — pure functions, no side effects
export function randInt(max: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return (buf[0] ?? 0) % max
}

export function pick<T>(pool: readonly T[]): T {
  return pool[randInt(pool.length)]!
}
```
One file per category (`random.ts`, `time.ts`, `format.ts`). Wildcard barrel re-export.

---

## 9. TypeScript Configuration

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "paths": {
      "@/*": ["./src/*"],
      "@worker/*": ["./worker/*"]
    }
  },
  "include": ["src", "tests"]
}
```

### Rules:
- **No `any`.** Ever.
- **No `as` type casting.** Use type guards, Zod, or proper generics.
- Path aliases: `@/*` → `src/*`, `@worker/*` → `worker/*`
- Worker has its own `worker/tsconfig.json` with `@cloudflare/workers-types`

---

## 10. Testing

### Unit tests — Vitest + happy-dom + React Testing Library

```typescript
// tests/crypto/crypto.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

describe('encrypt / decrypt', () => {
  it('round-trips a message', async () => {
    const message = 'Hello, world!'
    const { ciphertext, iv, key } = await encrypt(message)
    const decrypted = await decrypt(ciphertext, iv, key)
    expect(decrypted).toBe(message)
  })

  it('rejects tampered ciphertext', async () => {
    const { ciphertext, iv, key } = await encrypt('secret')
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff
    await expect(decrypt(ciphertext, iv, key)).rejects.toThrow()
  })
})
```

### Hook tests
```typescript
import { renderHook, act } from '@testing-library/react'

it('toggles theme', () => {
  const { result } = renderHook(() => useTheme())
  act(() => result.current.toggleTheme())
  expect(result.current.theme).toBe('light')
})
```

### Mocking pattern
```typescript
vi.mock('@/crypto', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}))

const mockEncrypt = vi.mocked(encrypt)

beforeEach(() => {
  vi.resetAllMocks()
})
```

### E2E — Playwright
```typescript
// e2e/create-note.spec.ts
import { test, expect } from '@playwright/test'

test('creates a note and shows link', async ({ page }) => {
  await page.route('/shard', (route) => route.fulfill({ status: 200, body: '{"id":"abc123"}' }))
  await page.goto('/')
  await page.locator('textarea').fill('secret message')
  await page.getByRole('button', { name: /create/i }).click()
  await expect(page.getByText(/link/i)).toBeVisible()
})
```

### Configuration
```typescript
// vitest.config.ts
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
})
```

```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'yarn dev', url: 'http://localhost:5173' },
})
```

---

## 11. Routing (SPA)

No react-router. Manual routing in App.tsx.

```typescript
// src/App.tsx
export function App() {
  const route = useHashRoute()

  // Path-based routes for tool/info pages
  if (window.location.pathname === '/docs') {
    return <Layout isDocs><Docs /></Layout>
  }
  if (window.location.pathname === '/settings') {
    return <Layout><Settings /></Layout>
  }

  // Fragment-based routes for core flow
  if (route.mode === 'create') {
    return <Landing />
  }

  return <Layout><ReadNote {...route} /></Layout>
}
```

- **Path-based** (`window.location.pathname`) for static tool pages (`/docs`, `/settings`)
- **Fragment-based** (`useHashRoute()`) for core app flow (create, read, protected)
- Layout wrapper pattern — pages render inside `<Layout>` which provides header, footer, theme toggle

---

## 12. Worker / Backend

### Interface-first design
```typescript
// worker/shard-store.ts
export interface ShardStore {
  put(id: string, shard: string, ttl: number): Promise<void>
  get(id: string): Promise<string | null>
  exists(id: string): Promise<boolean>
  delete(id: string): Promise<boolean>
}

export class CloudflareKVShardStore implements ShardStore { /* ... */ }
export class InMemoryShardStore implements ShardStore { /* ... */ }
```
Abstract the storage interface from day one — even if only one implementation exists. This enables swappable backends later.

### Zod validation for request bodies
```typescript
import { z } from 'zod'

const StoreShardSchema = z.object({
  shard: z.string().regex(/^[A-Za-z0-9_-]{20,24}$/),
  ttl: z.number().refine(
    (v): v is (typeof VALID_TTLS)[number] =>
      (VALID_TTLS as readonly number[]).includes(v),
    { message: `ttl must be one of: ${VALID_TTLS.join(', ')}` },
  ),
})

// In request handler:
const parsed = StoreShardSchema.safeParse(body)
if (!parsed.success) {
  return Response.json({ error: 'Invalid request' }, { status: 400, headers })
}
```

### Worker has its own tsconfig
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true
  },
  "include": ["."],
  "exclude": ["../tests"]
}
```

---

## 13. SEO for SPAs

### index.html checklist
- `<title>` and `<meta name="description">`
- `<meta property="og:title/description/image/url/type">` — OG image should be 1200×630
- `<meta name="twitter:card" content="summary_large_image">`
- `<link rel="canonical" href="https://yapgone.com/">`
- `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`
- `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`
- `<link rel="manifest" href="/manifest.json">`
- `<meta name="theme-color" content="#0a0a0a">`
- JSON-LD `<script type="application/ld+json">` with WebApplication and/or FAQPage schema
- `<noscript>` fallback explaining the app requires JavaScript

### Page-level SEO
Each page sets `document.title` and meta description via `useEffect` with cleanup (see Section 4).

### Static files
- `/public/robots.txt` — allow all
- `/public/sitemap.xml` — list canonical pages
- `/public/manifest.json` — PWA metadata (name, icons, theme_color, background_color)

---

## 14. DevContainer

```json
{
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "forwardPorts": [5173, 8787],
  "postCreateCommand": "bash .devcontainer/post-create.sh",
  "containerEnv": {
    "VITE_API_URL": "http://localhost:8787"
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode",
        "vitest.explorer",
        "ms-azuretools.vscode-docker"
      ]
    }
  }
}
```

`post-create.sh`:
```bash
yarn install --frozen-lockfile
```

---

## 15. Anti-Patterns to Avoid

- **No Tailwind.** CSS Modules only (`.module.css`). No utility-class frameworks.
- **No `any`.** No `as` type casting. Use type guards, generics, or Zod.
- **No colocated tests.** Tests go in `tests/` mirroring `src/` structure.
- **No class components.** Pure function components only.
- **No global CSS from components.** CSS Modules scope everything. Global styles only in `src/styles/`.
- **No external font CDNs.** System font stack or self-hosted fonts only.
- **No default exports.** Named exports everywhere, barrel files re-export.
- **No external UI component libraries.** Build UI from scratch with CSS Modules.
- **No external state management.** React hooks only (useState, useCallback, useRef, useEffect).
- **No react-router.** Manual pathname/fragment routing in App.tsx.

---

## Code Conventions (Summary)

| Rule | Detail |
|---|---|
| Strict TypeScript | `strict: true`, `noUncheckedIndexedAccess`, no `any`, no `as` |
| CSS Modules | `.module.css`, camelCase class names, no global selectors from components |
| Named exports only | No default exports. Barrel `index.ts` in every directory |
| Hooks for logic | One hook per file, return objects, export types alongside |
| Constants as const | `UPPER_SNAKE_CASE`, `as const` for literal types |
| Pure utils | One file per category, no side effects, wildcard barrel |
| Interface-first | Abstract backends behind interfaces from day one |
| Zod for validation | External/untrusted input validated with Zod schemas |
| Web Crypto only | No external crypto libraries (if crypto is needed) |
| Tests mirror src/ | `tests/api/`, `tests/hooks/`, etc. — never colocated |

---

## Vite Config Template

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
```

---

## Node Version

Use Node 22 (LTS). Pin in `.nvmrc`:
```
22.14.0
```
