# Project

Notefade Chat is a privacy-first, zero-knowledge, anonymous, ephemeral encrypted real-time chat app. Two (or more) participants communicate through end-to-end encrypted WebSocket channels. The server is a dumb relay — it never sees plaintext, never stores messages, and never holds encryption keys. Sessions fade away when the conversation ends.

Built as a sibling product to [Notefade](https://notefade.com) (one-time secret sharing). Same philosophy: the server should have nothing worth stealing.

# How It Works

## Architecture
- **Frontend:** React + TypeScript + Vite, CSS Modules. Static SPA hosted on Cloudflare Pages.
- **Backend (relay):** Cloudflare Workers + Durable Objects. WebSocket relay only — receives encrypted blobs, forwards them. Stores zero plaintext.
- **Package manager:** yarn
- **No SSR.** No Next.js. No server-side rendering. Fully client-side SPA.
- **Real-time:** WebSocket connections managed by Cloudflare Durable Objects (one DO instance per chat room).

## Encryption Flow (Per Session)
1. **Room creation:** Creator generates an ECDH P-256 key pair (Web Crypto API). Room ID is created server-side (Durable Object).
2. **Invite link:** `notefade.com/chat#<roomID>:<base64url(creatorPublicKey)>` — fragment is never sent to server.
3. **Joiner connects:** Joiner generates their own ECDH key pair, extracts creator's public key from the URL fragment, connects via WebSocket.
4. **Key exchange:** Joiner sends their public key over the WebSocket. Both sides perform ECDH → shared secret. Server relays the public key but cannot derive the shared secret.
5. **Double Ratchet initialization:** Shared secret seeds a Double Ratchet (symmetric ratchet + DH ratchet). Every message gets a unique key.
6. **Per-message encryption:** Each message encrypted with AES-256-GCM using the current ratchet-derived message key. IV is fresh per message.
7. **Session end:** When participants disconnect or TTL expires, the Durable Object destroys itself. No message history persists anywhere.

## Key Design Decisions
- **ECDH P-256, not X25519.** P-256 has universal Web Crypto API support across all browsers. X25519 support is newer and inconsistent. P-256 is NIST-approved, well-audited, and sufficient for this threat model. Can revisit when X25519 Web Crypto support is universal.
- **Double Ratchet protocol.** Provides forward secrecy (compromise of current key doesn't reveal past messages) and break-in recovery (future messages become secure again after a DH ratchet step). This is the same core protocol used by Signal.
- **Durable Objects, not KV.** Chat requires stateful WebSocket connections. Durable Objects provide exactly this — a single-threaded, persistent WebSocket handler per room. KV is for static key-value lookups (used by Notefade for shards), not real-time relay.
- **XOR key splitting for invite links.** For the initial key material in the URL, XOR splitting (same as Notefade) ensures neither the URL alone nor the server alone can derive the session secret. For 2-of-2 splits, XOR is information-theoretically secure.
- **No message persistence.** Messages exist only in participants' browser memory during the session. The server never stores them. When the tab closes, they're gone.
- **URL fragment (#) for crypto material.** Same as Notefade — browsers never send fragments to the server.

## Data Flow
```
Invite URL fragment (#):
  ├─ room ID              (variable)   → tells server which Durable Object to route to
  └─ creator public key   (65 bytes*)  → P-256 uncompressed public key, base64url-encoded
      (* or 33 bytes if compressed format is used)

WebSocket messages (server sees only):
  ├─ type                 (string)     → "pubkey" | "message" | "typing" | "leave"
  ├─ payload              (bytes)      → encrypted blob (AES-256-GCM ciphertext + IV + tag)
  └─ nonce/counter        (number)     → message ordering, not cryptographic

Server (Durable Object):
  └─ room state           → connected client list, nothing else
  └─ TTL                  → auto-destroys after inactivity timeout
  └─ zero stored messages → relay only, no persistence
```

## File Structure (Target)
```
/src
  /components          → React UI components (ChatRoom, MessageBubble, JoinRoom, etc.)
  /crypto
    /ratchet.ts        → Double Ratchet implementation (DH ratchet + symmetric ratchet)
    /ecdh.ts           → ECDH key pair generation, shared secret derivation
    /encrypt.ts        → AES-256-GCM encrypt/decrypt per message
    /kdf.ts            → HKDF-based key derivation for ratchet chains
    /keys.ts           → Key splitting (XOR), key serialization, key types
  /ws
    /client.ts         → WebSocket client wrapper (connect, send, receive, reconnect)
    /protocol.ts       → Message framing, type definitions, serialization
  /hooks               → React hooks (useChat, useWebSocket, useCrypto)
  /styles              → CSS Modules
  /types               → Shared TypeScript types
/worker
  /index.ts            → Cloudflare Worker entry point (routes to Durable Object)
  /chat-room.ts        → Durable Object class (WebSocket relay, room lifecycle)
/public                → Static assets
CLAUDE.md
ARCHITECTURE.md        → Deep technical reference
PROJECT.md             → Milestones and implementation plan
```

# Brand Voice

IMPORTANT:
- Same as Notefade: calm, minimal, modern. Confident but not paranoid.
- Short, clear sentences. No fluff. Technical accuracy without jargon.
- NEVER use: "military-grade encryption", "unhackable", "100% secure", "bulletproof", "Fort Knox", "bank-level security", "your data is safe with us"
- NEVER overclaim. We cannot prevent screenshots, copy-paste, or a compromised device. Say so honestly.
- Preferred tone: like a friend who understands crypto whispering "here, use this" — not a cybersecurity vendor pitch deck.
- The word "fade" should be reflected in the brand — conversations gently disappear, not violently self-destruct.
- Chat-specific language: "conversations fade", "nothing lingers", "speak freely, then let it go"

# Gotchas

- **`crypto.subtle` requires secure context.** HTTPS in production, `http://localhost` works for dev. Never deploy without TLS.
- **WebSocket + Durable Objects billing.** Durable Objects bill per wall-clock duration, not just CPU. A long-lived WebSocket connection costs money even when idle. Implement aggressive inactivity timeouts (e.g., 30 min idle → room destroyed).
- **Durable Objects are single-region.** The DO instance lives in one Cloudflare region. Latency is fine for chat but be aware — unlike KV which replicates globally, DOs run in one place. The initial connection routes to the nearest region that supports DOs.
- **P-256 public key size.** Uncompressed P-256 public keys are 65 bytes (0x04 prefix + 32-byte X + 32-byte Y). In the URL fragment, this base64url-encodes to ~88 characters. Acceptable for URL length.
- **Double Ratchet complexity.** The DH ratchet step requires a new ECDH key pair per ratchet turn. `crypto.subtle.generateKey()` is async. Message ordering matters — out-of-order messages require skipped message key storage. Implement message number tracking.
- **Memory zeroing is best-effort in JS.** `TypedArray.fill(0)` zeroes the buffer, but V8 may retain copies in JIT code, GC, or string interning. Don't promise "keys are wiped from memory" — say "we minimize key exposure."
- **The participant IS the threat model gap.** Any participant can extract keys from devtools, screenshot messages, or use a compromised browser. This is an accepted limitation. Be honest about it.
- **No accounts for MVP.** Anonymous-only. No auth. The chat room link IS the access credential.
- **WebSocket reconnection.** If a participant's connection drops and they reconnect, they need to re-establish the ratchet state. Store ratchet state in memory (sessionStorage is an option for tab-survive, but adds attack surface). For MVP, dropped connection = new session.
- **Concurrent Durable Object alarm limits.** Each Durable Object can have one alarm at a time. Use it for the inactivity TTL, but don't try to schedule multiple alarms.
- **`btoa`/`atob` limitations.** These fail on non-Latin1 characters. Use `Uint8Array` ↔ `String.fromCharCode` for binary data. For message text, encode UTF-8 to `Uint8Array` via `TextEncoder` before encrypting.

# Workflow

## Development Priorities
1. **Crypto primitives first** (`/src/crypto/`) — ECDH key generation, shared secret derivation, AES-256-GCM encrypt/decrypt, HKDF, XOR key splitting
2. **Double Ratchet second** (`/src/crypto/ratchet.ts`) — symmetric ratchet chain, DH ratchet, message key derivation, skipped message keys
3. **WebSocket relay third** (`/worker/`) — Durable Object for room lifecycle, WebSocket upgrade, message forwarding, TTL/alarm cleanup
4. **WebSocket client fourth** (`/src/ws/`) — connect, reconnect, message framing, protocol types
5. **Chat UI fifth** — Room creation, invite link display, join flow, message list, input, typing indicators
6. **Polish last** — Animations (fade-in/out for messages), sound cues, copy-link UX, mobile responsiveness

## Code Conventions
- All crypto operations use Web Crypto API only. Zero external crypto dependencies.
- `RelayServer` interface must be abstracted from day one (even if only Cloudflare Durable Objects is implemented). This enables self-hosted relays as a v2 feature.
- File naming: `kebab-case.ts` for files, `PascalCase` for components
- CSS Modules with `.module.css` suffix
- No TailwindCSS — CSS Modules only
- Strict TypeScript. No `any`. No `as` type casting. Use Zod for runtime validation of WebSocket messages and external data.
- All WebSocket message types defined in `/src/ws/protocol.ts` with discriminated unions.
- React hooks for all stateful chat logic (`useChat`, `useWebSocket`, `useCrypto`).

## What Claude Should Never Do Without Approval
- Add any server-side storage of message content (encrypted or not)
- Add any analytics, tracking, or telemetry scripts
- Add any third-party JS that loads on pages handling secrets or chat sessions
- Add user accounts or authentication (MVP is anonymous-only)
- Use any crypto library other than Web Crypto API
- Store plaintext or keys in localStorage/sessionStorage (memory-only for MVP)
- Add file upload/sharing features (adds complexity and attack surface)
- Deploy without HTTPS
- Add message persistence or chat history features
- Implement group chat (MVP is 1-to-1 only, architecture should support extension later)
- Change the ECDH curve without discussing security implications
- Add read receipts that leak metadata to the server
- Implement Stealth Mode (v2) without discussing tradeoffs — it affects latency, bandwidth, battery, and server cost

## v2 Features (Documented, Not Implemented in MVP)
- **Stealth Mode:** Opt-in mode combining two defenses. See `ARCHITECTURE.md` for full protocol design.
  - **Cover Traffic (Chaff Messages):** Constant-rate, constant-size encrypted message stream. A 1-byte flag inside the ciphertext distinguishes real messages (`0x01`) from chaff (`0x00`). The server sees identical blobs at fixed intervals — cannot distinguish activity from silence. Defeats timing, frequency, and size metadata analysis.
  - **Dual-Channel XOR Ciphertext Splitting:** After AES-256-GCM encryption, XOR-split the ciphertext into two shares sent over independent channels (WebSocket relay + WebRTC P2P data channel). The server only ever sees one share — information-theoretically irrecoverable without the other. Defeats traffic recording + future key compromise attacks.
  - **Combined:** Both features layer — constant-rate padded blobs, each XOR-split across two channels. Maximum metadata resistance achievable in a browser.
  - **Tradeoffs:** Added latency (messages wait for next interval slot), doubled bandwidth, constant CPU/battery drain, WebRTC infrastructure dependency (STUN/TURN). Mode is negotiated inside the encrypted channel — the server does not know which mode participants chose.
- **Safety Number Verification:** Fingerprint derived from both public keys, compared out-of-band to detect active MITM during key exchange.
- **Group Chat:** Requires Sender Keys or pairwise ratchets. Architecture should not prevent extension but MVP is 1-to-1 only.
