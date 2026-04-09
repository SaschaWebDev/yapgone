<div align="center">
  <img src="public/yapgone-logo.png" alt="yapgone logo" width="128" height="128" />

  <h1>yapgone</h1>

  <p><strong>Encrypted yapping, gone for good</strong></p>

  <p>
    <img src="https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white" alt="TypeScript strict" />
    <img src="https://img.shields.io/badge/crypto%20deps-zero-green" alt="Zero crypto deps" />
    <img src="https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  </p>

  <!-- TODO: record and add a demo gif at docs/yapgone-demo.gif then re-enable -->
  <!-- <img src="docs/yapgone-demo.gif" alt="yapgone demo" width="600" /> -->
</div>

---

yapgone is an ephemeral, end-to-end encrypted chat app for private conversations and groups of up to 20 users. Text, voice notes, inline videos, photos, files, polls, predictions, voice calls, video calls, and group voice — all encrypted client-side, relayed through a zero-knowledge server, and gone when you're done. No accounts, no cookies, no history. Close the tab, and the conversation never existed.

Under the hood, yapgone uses a Signal-like double ratchet for 1-to-1 chats and a sender key protocol with ECDSA signing for groups. All cryptography runs in the browser via the Web Crypto API — zero external crypto dependencies. The server is a stateless relay that never sees plaintext, keys, or identities. Everything lives in browser memory and vanishes on tab close or room expiry.

## ✨ Features

**Messaging**

- Text messages with inline replies and emoji reactions
- 15-second timed messages that self-destruct after viewing
- Voice notes (up to 120s) with waveform visualization and playback speed control
- View-once voice notes
- Inline video messages (mp4, webm, ogg, quicktime, x-matroska — up to 50 MiB, played with native browser controls)
- Photo galleries (up to 5 images per gallery, 15 MiB per photo, lightbox with zoom and pan; the picker also accepts videos which are dispatched as individual video messages)
- Camera capture (direct photo from device camera)
- File sharing (up to 10 MiB for general files, chunked transfer)
- Polls (up to 20 options)
- Predictions (yes/no or custom outcomes, time-limited voting, moderator-resolved outcome with a pulsing CTA when voting closes)
- Notefade integration (URL-based self-destructing notes with client-side BYOK encryption)
- In-chat self-destructing notes (`notefade-chat` kind — sender writes the note inside the chat, recipient reveals once, then it's destroyed for everyone)

**Voice & Screen**

- 1-on-1 voice calls with optional E2EE (AES-256-GCM frame encryption via WebRTC Encoded Transforms in a dedicated Web Worker)
- 1-on-1 video calls with the same E2EE on the video track
- Group voice for 3–10 participants over the encrypted WebSocket relay (no WebRTC mesh; the worker forwards opaque encrypted frames)
- Screen sharing with floating draggable window

**Group Chat**

- 2–20 participants (default 2; the slider in the room settings lets the creator pick anywhere in this range)
- Sender key protocol with ECDSA P-256 signing
- Automatic rekey on member departure
- Pairwise ECDH ratchets for sender key distribution

**Security**

- Double ratchet protocol (forward secrecy + future secrecy)
- Safety numbers (60-digit fingerprint verification)
- Safeword room protection (PBKDF2-SHA256, 120,000 iterations)
- XOR invite splitting (information-theoretically secure)
- Cryptographic erasure (keys zeroed on room close)

**Privacy**

- No accounts, no cookies, no tracking
- Zero-knowledge relay server
- 30-minute room inactivity expiry
- Everything in-memory, nothing persisted (server stores only the per-room `maxClients` config and transient reconnect grace records)
- Mobile-friendly reconnect — the same identity is preserved across iOS Safari tab evictions and short backgrounding via a per-tab `cid` in `localStorage`. The worker recognizes reconnects with the same `cid` as resumes within an 8-second grace window, so the participant count never inflates and the slot is held while the user is briefly away.

**UX**

- Dark and light themes
- QR code sharing
- Web Share API support
- Browser notifications
- Typing indicators
- Connection quality status
- Inactivity countdown timer
- Optional usernames (up to 24 characters)
- PWA-ready

## ⚙️ How It Works

1. **Creator** opens yapgone and creates a new room
2. Client generates an **ECDH P-256 key pair** — the private key never leaves the browser
3. The 65-byte raw public key is **XOR-split** into two random shares
4. **Share 1** goes into the URL fragment (`#roomId:~share1`) — fragments are never sent to the server
5. **Share 2** is stored in Cloudflare KV (`shard:{roomId}`) with a 1-hour TTL
6. Creator sends the invite link via any channel
7. **Joiner** opens the link — the app parses the fragment to extract Share 1
8. Joiner **fetches Share 2** from KV (one-time read, deleted immediately)
9. Shares are **XOR-combined** to reconstruct the creator's public key
10. Both parties connect via **WebSocket** and exchange public keys
11. **ECDH shared secret** → HKDF → root key → double ratchet initialized
12. All subsequent messages are **AES-256-GCM encrypted** with ratcheted keys
13. After 30 minutes of inactivity, the room **expires** and all connections close
14. All crypto state is **zeroed** — keys, chains, skipped buffers — nothing remains

```
  Creator                        Server                        Joiner
    │                              │                              │
    ├──POST /api/rooms────────────►│                              │
    │◄─────────{ roomId }──────────┤                              │
    │                              │                              │
    │  generate ECDH key pair      │                              │
    │  XOR-split pubkey            │                              │
    │  share1 → URL fragment       │                              │
    │                              │                              │
    ├──POST shard (share2)────────►│  KV: shard:{roomId}          │
    │                              │  TTL: 1 hour                 │
    │                              │                              │
    │        ┌─── send invite link (any channel) ───┐             │
    │        └──────────────────────────────────────►│             │
    │                              │                 │             │
    │                              │  parse fragment (share1)     │
    │                              │◄─GET shard──────┤             │
    │                              │──{ share2 }────►│             │
    │                              │  (deleted)      │             │
    │                              │                 │ XOR-combine │
    │                              │                 │ → pubkey    │
    │                              │                              │
    ├──WebSocket /ws/:roomId?cid=──►│◄──WebSocket /ws/:roomId?cid=──┤
    │                              │                              │
    │◄═══════ pubkey exchange (via relay) ═══════════════════════►│
    │          ECDH → shared secret → HKDF → root key            │
    │          Double ratchet initialized                         │
    │                              │                              │
    │◄══════ AES-256-GCM encrypted messages ════════════════════►│
    │         (server sees only ciphertext)                       │
    │                              │                              │
    │          ... 30 min inactivity ...                          │
    │                              │                              │
    │◄──────── room-expired ───────┤──── room-expired ───────────►│
    │                              │                              │
    │  destroyState() → keys zeroed                keys zeroed   │
```

**Reconnect resume** (mobile background, network blip, iOS tab eviction):

```
  Client                           Server
    │                                 │
    │  WS_old closes (network blip)   │
    │═════════ X ════════════════════▶│
    │                                 │  webSocketClose:
    │                                 │  store departing:{cid}
    │                                 │  schedule finalizeDeparture(+8s)
    │                                 │  (peer-left NOT fired yet)
    │                                 │
    │                                 │
    │  reconnect with same cid        │
    ├──WebSocket /ws/:roomId?cid=A───▶│
    │                                 │  duplicate? yes → close old socket
    │                                 │  departing:A exists → resume
    │                                 │  delete departing:A
    │                                 │  accept new socket
    │                                 │  peer-joined SUPPRESSED (resume)
    │◄──── peer-list { yourId: A } ───┤
    │                                 │
    │  state preserved → no-op        │
    │                                 │
    │     ... or, if grace expired (>8s):
    │                                 │
    │                                 │  finalizeDeparture fires
    │                                 │  → peer-left { cid: A } to peers
    │                                 │  → slot freed
    │                                 │
    │  reconnect with same cid        │
    ├──WebSocket /ws/:roomId?cid=A───▶│
    │                                 │  no duplicate, no departing
    │                                 │  capacity check (unique cids only)
    │                                 │  accept as fresh join
    │                                 │  peer-joined → fellow peers
    │                                 │  re-key exchange
```

## 🔐 Cryptographic Protocol

### Key Exchange (ECDH P-256)

Peers generate ephemeral ECDH key pairs on the P-256 (secp256r1) curve. Public keys are exported as 65-byte uncompressed raw format and exchanged via the relay. The shared secret is derived using `crypto.subtle.deriveBits` (256 bits), then fed into HKDF to produce the initial root key.

Neither the shared secret nor private keys ever leave the client. The server only relays the encrypted public key exchange messages.

> Source: [`src/crypto/ecdh.ts`](src/crypto/ecdh.ts)

### Symmetric Encryption (AES-256-GCM)

All message payloads are encrypted with AES-256-GCM:

- **256-bit keys** derived per-message from the ratchet chain
- **12-byte random IVs** generated via `crypto.getRandomValues`
- **16-byte authentication tags** (GCM standard)
- **Optional AAD** (Additional Authenticated Data) — used by the double ratchet to bind headers to ciphertext

Every message uses a unique key derived from the symmetric ratchet. No key is ever reused.

> Source: [`src/crypto/encrypt.ts`](src/crypto/encrypt.ts)

### Key Derivation

Two derivation functions provide the backbone of the ratchet system:

- **HKDF-SHA256** — expands ECDH shared secrets into root keys and chain keys. Used at DH ratchet steps to derive 64 bytes (32-byte root key + 32-byte chain key).
- **HMAC-SHA256** — advances the symmetric ratchet one step at a time:
  ```
  HMAC(chainKey, 0x01) → nextChainKey
  HMAC(chainKey, 0x02) → messageKey
  ```
  The chain key is consumed and replaced; the message key is used once for AES-256-GCM, then discarded.

> Source: [`src/crypto/kdf.ts`](src/crypto/kdf.ts)

### Double Ratchet (1-to-1)

The double ratchet combines three ratchet mechanisms for continuous key renewal:

1. **DH Ratchet** — on each new message direction, a fresh ECDH key pair is generated. The new DH output feeds into HKDF with the current root key to produce a new root key and a new chain key.
2. **Root Key Ratchet** — each DH ratchet step updates the root key. Compromising one root key doesn't reveal past or future root keys because each derivation requires a new DH output.
3. **Symmetric Key Ratchet** — within a single sending chain, HMAC-SHA256 advances the chain key one step per message, producing a unique message key for each.

**Header as AAD**: The message header `{pubkey, n, pn}` is JSON-serialized and passed as Additional Authenticated Data to AES-256-GCM. This binds the ratchet metadata to the ciphertext — any tampering with the header causes decryption to fail.

**Out-of-order messages**: Up to 100 skipped message keys are cached (indexed by `pubkey:messageNumber`) to handle messages arriving out of order. Skipped keys are consumed on use and never reused.

**Forward secrecy**: Compromising the current state doesn't reveal past message keys — chain keys are one-way (HMAC), and past DH private keys are discarded.

**Future secrecy (break-in recovery)**: If an attacker compromises the current state, the next DH ratchet step introduces a new DH exchange that the attacker cannot predict, restoring confidentiality.

> Source: [`src/crypto/ratchet.ts`](src/crypto/ratchet.ts)

### Sender Keys (Group Chat)

Group messages use a sender key protocol to avoid `O(n)` pairwise encryptions per message:

1. Each member generates an **ECDSA P-256 signing key pair** and a random **32-byte chain key**
2. The signing public key and chain key are **distributed to all peers** via pairwise-encrypted ratchet channels
3. To send a group message:
   - Advance the chain key via `kdfRatchetStep` to get a message key
   - Encrypt the plaintext with AES-256-GCM using the message key
   - Sign `(messageNumber ‖ IV ‖ ciphertext)` with ECDSA-SHA256
   - Broadcast `{messageNumber, iv, ciphertext, signature}` to the group
4. Recipients **verify the signature first**, then derive the message key from their copy of the sender's chain key

**Out-of-order support**: Same 100-key skip buffer as the double ratchet.

**Rekey on departure**: When a member leaves, all remaining members generate new sender keys and redistribute them. This ensures the departed member cannot decrypt future messages.

> Source: [`src/crypto/sender-keys.ts`](src/crypto/sender-keys.ts)

### Group Key Exchange

Group members establish pairwise ECDH ratchets between every pair. These pairwise channels are used exclusively for distributing sender keys — actual group messages go through the sender key protocol.

**Deterministic role assignment**: The member with the lexicographically lower `clientId` takes the "initiator" (creator) role; the other takes the "joiner" role. This avoids role negotiation and ensures both sides initialize the ratchet consistently.

**Sender key distribution**: Each member's sender key material (ECDSA public key + chain key) is ratchet-encrypted and sent to each peer over their pairwise channel. When a rekey occurs, the new sender key is distributed the same way.

> Source: [`src/crypto/group-key-exchange.ts`](src/crypto/group-key-exchange.ts)

### Invite Link Security (XOR Splitting)

The creator's 65-byte ECDH public key is split into two shares using XOR:

```
share1 = random(65 bytes)
share2 = pubkey ⊕ share1
```

- **Share 1** is placed in the URL fragment (`#roomId:~share1`). Fragments are never sent to the server per the HTTP specification — they stay in the browser.
- **Share 2** is stored in Cloudflare KV with a 1-hour TTL and deleted on first read.

This provides **information-theoretic security**: either share alone is uniformly random and reveals nothing about the public key. An attacker must intercept both the link and the KV shard. Even a fully compromised server only sees Share 2 — useless without Share 1.

> Source: [`src/crypto/keys.ts`](src/crypto/keys.ts)

### Media Encryption (WebRTC E2EE)

Voice call audio frames are encrypted using WebRTC Encoded Transforms in a dedicated Web Worker:

**Frame wire format:**

```
[4-byte counter BE | 12-byte IV | encrypted payload + 16-byte GCM tag]
```

**IV construction:**

```
[4-byte random session salt | 4-byte zero padding | 4-byte counter BE]
```

- The session salt is generated once per call and randomizes the IV space
- The counter is monotonically increasing per-sender, preventing IV reuse
- Unencrypted frames are **dropped** — never sent or decoded
- The media key is derived from the ratchet root key via HKDF with a dedicated salt (`yapgone-media-key`) and info (`aes-256-gcm-media`)

> Source: [`src/workers/media-crypto-worker.ts`](src/workers/media-crypto-worker.ts), [`src/crypto/media-key.ts`](src/crypto/media-key.ts)

### Safety Numbers

Safety numbers allow peers to verify they're communicating directly without a MITM:

1. Both public keys are sorted lexicographically
2. Sorted keys are concatenated and hashed with SHA-256
3. The first 24 bytes of the digest are split into 12 groups of 2 bytes
4. Each group is converted to a 5-digit zero-padded decimal number (range 0–65535)
5. Result: **60 decimal digits** displayed as `12345 67890 12345 ...` (12 groups of 5)

For groups, all participant public keys are sorted, concatenated, and hashed the same way, producing a group fingerprint.

The same input always produces the same output. If a MITM substitutes a key, the safety numbers won't match.

> Source: [`src/crypto/safety-number.ts`](src/crypto/safety-number.ts)

### Safeword Protection

Room creators can set a safeword — a shared secret that joiners must enter before accessing the room:

- **PBKDF2-SHA256** with **120,000 iterations**
- **16-byte random salt** per room
- **Constant-time comparison** to prevent timing attacks
- **3 attempts** before lockout

The safeword hash and salt are stored in the invite link settings (base64url-encoded in the URL fragment). The plaintext safeword is never transmitted or stored.

> Source: [`src/room-settings.ts`](src/room-settings.ts)

### Cryptographic Erasure

When a room is closed, expired, or navigated away from, `destroyState()` is called:

- Root key → zeroed
- Send chain key → zeroed
- Receive chain key → zeroed
- All skipped message keys → zeroed and cleared
- Sender key chain keys → zeroed
- Received sender keys → zeroed and cleared

This is active key destruction, not garbage collection. Even if memory is later dumped, the keys are gone.

> Source: [`src/crypto/ratchet.ts`](src/crypto/ratchet.ts) (`destroyState`), [`src/crypto/sender-keys.ts`](src/crypto/sender-keys.ts) (`destroySenderKeyState`, `destroyReceivedSenderKey`), [`src/crypto/group-key-exchange.ts`](src/crypto/group-key-exchange.ts) (`destroyGroupMemberCrypto`)

## 🛡️ Security Model

**yapgone protects against:**

- Server compromise — the relay never sees plaintext, keys, or identities
- Data breaches — nothing is stored; there's nothing to breach
- Subpoenas — the server has no chat history, user data, or key material to hand over
- Network surveillance — all message content is AES-256-GCM encrypted
- Replay attacks — GCM authentication tags and ratcheted keys prevent replays
- MITM attacks — safety number verification detects key substitution
- Invite link interception — XOR splitting means neither the URL nor the server shard alone reveals the public key
- Forward secrecy — compromising current keys doesn't reveal past messages (HMAC chains are one-way, past DH keys are discarded)
- Future secrecy — after a key compromise, the next DH ratchet step restores confidentiality (break-in recovery)
- Group member departure — automatic rekey ensures departed members can't read future messages

**yapgone does NOT protect against:**

- Screenshots, copy-paste, or screen recording by the other party
- Compromised devices — keyloggers, malware, malicious browser extensions
- Recipient forwarding messages to third parties
- Traffic analysis — an observer can see message timing, sizes, and frequency even though content is encrypted
- Room ID correlation — if an adversary knows a room ID, they can observe connection patterns
- IP address exposure — the server and WebRTC peers can see your IP; use a VPN or Tor for anonymity
- Browser vulnerabilities — a zero-day in the browser or Web Crypto implementation could undermine everything
- Web Crypto side-channel attacks — the browser's crypto implementation may be vulnerable to timing or cache attacks that are outside our control

No security tool is a silver bullet. yapgone is designed for ephemeral private conversations, not for protecting state secrets against nation-state adversaries with physical access to your device. Use it as one layer in your security practices, not the only one.

**Security headers**: The Cloudflare Workers deployment serves responses with CORS headers configured to allow cross-origin requests for the API. In production, consider tightening `Access-Control-Allow-Origin` to your specific domain.

## 👁️ What the Server Sees

### What the relay CAN observe

| Data               | Details                                                        |
| ------------------ | -------------------------------------------------------------- |
| Room ID            | UUID, randomly generated per room                              |
| Client IDs         | UUIDs assigned on WebSocket connect, not linked to identities  |
| Message type field | `pubkey`, `message`, `direct`, `typing`, `leave`, `close-room` |
| Typing status      | Whether a client is currently typing (boolean)                 |
| Join/leave timing  | When each client connected and disconnected                    |
| Participant count  | Number of active WebSocket connections per room                |
| Source IPs         | Visible via `CF-Connecting-IP` header                          |
| Message sizes      | Byte length of each WebSocket frame                            |
| Message timing     | When each message was relayed                                  |

### What the relay CANNOT observe

| Data                | Why                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| Message content     | Encrypted client-side with AES-256-GCM before reaching the server          |
| Encryption keys     | Generated and used entirely in the browser; never transmitted in cleartext |
| Public keys         | Exchanged via encrypted WebSocket messages; server relays opaque payloads  |
| User identities     | No accounts, no authentication, no cookies — just ephemeral UUIDs          |
| File contents       | Encrypted and chunked client-side before transmission                      |
| Voice note contents | Encrypted client-side before transmission                                  |
| Image contents      | Encrypted client-side before transmission                                  |
| Voice call audio    | Encrypted via WebRTC Encoded Transforms; server is not in the media path   |

### What the relay does NOT store

Messages are relayed in real-time to connected WebSocket peers and immediately discarded. The only persisted state on the server side is operational metadata, never message content or identities:

- **DO storage**: per-room `maxClients` configuration, plus transient `departing:{clientId}` records that auto-expire after the 8-second reconnect grace window
- **KV**: invite shards keyed by `shard:{roomId}`, 1-hour TTL, deleted on first read

No messages, no keys, no user profiles, no chat history, no connection logs.

### KV storage (invite shards only)

| Property    | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Key format  | `shard:{roomId}`                                            |
| Value       | Base64url-encoded XOR share (useless without the URL share) |
| TTL         | 1 hour                                                      |
| Read policy | Deleted on first GET (one-time read)                        |

### Durable Object state

| Property                          | Persistence                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| Client IDs                        | In-memory only (WebSocket attachment, per-tab `cid` from query string)      |
| Client count                      | Derived from unique active client IDs (deduped, never raw socket count)     |
| Max participants                  | Stored in DO storage (configurable per room)                                |
| `departing:{clientId}` records    | DO storage, auto-expires after 8s grace window for reconnect resume         |
| WebSocket connections             | Transient (closed on room expiry)                                           |
| Inactivity alarm                  | DO alarm, reset on each message                                             |
| `peerHasJoined` flag              | In-memory only (prevents solo-creator expiry)                               |

That's it. No message logs, no key material, no user profiles.

## 🔄 Room Lifecycle

1. **Creation** — creator calls `POST /api/rooms`, receives a UUID room ID
2. **Key generation** — creator generates an ECDH P-256 key pair in the browser
3. **Invite splitting** — public key is XOR-split; Share 1 goes into the URL fragment, Share 2 is stored in KV
4. **Link sharing** — creator sends the invite link via any external channel
5. **Joining** — joiner opens the link, fetches Share 2 from KV (one-time read), reconstructs the public key
6. **Handshake** — both peers connect via WebSocket, exchange public keys, perform ECDH, initialize the double ratchet
7. **Reconnect resume** — every WebSocket connect carries a per-tab `cid` query parameter generated on first visit and stored in `localStorage`. If a connection drops (network blip, mobile backgrounding, iOS tab eviction), the next reconnect with the same `cid` is treated as a resume: the worker closes any duplicate sockets, restores the slot from a `departing:` record if within the 8-second grace window, and suppresses `peer-joined` notifications so the participant count stays stable. Capacity is enforced on **unique active cids + non-stale departing cids**, so a backgrounded user's slot is reserved while the cap remains a hard limit.
8. **Active chat** — all messages are ratchet-encrypted (1-to-1) or sender-key-encrypted (group)
9. **Group expansion** — new members trigger pairwise ratchet setup and sender key distribution with all existing members
10. **Member departure** — departing member's keys are destroyed; all remaining members rekey their sender keys
11. **Room expiry** — after 30 minutes of inactivity, the DO alarm fires, sends `room-expired` to all clients, closes all WebSocket connections, and deletes all DO storage

## 📡 API

### REST Endpoints

| Method  | Path                        | Description                                                                                               |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST`  | `/api/rooms`                | Create a new room. Optional `{ maxClients: 2–20 }` (UI-enforced; the worker schema permits up to 200 for direct API callers, but the UI slider caps at 20). Returns `{ roomId }`. |
| `PATCH` | `/api/rooms/:id/config`     | Update room config — `{ maxClients: 2–20 }`.                                                              |
| `POST`  | `/api/rooms/:id/shard`      | Store an XOR share for invite splitting. Body: `{ shard }`.                                               |
| `GET`   | `/api/rooms/:id/shard`      | Fetch and delete a shard (one-time read). Returns `{ shard }`.                                            |
| `POST`  | `/api/notefade/create-note` | Proxy to notefade API. Body: `{ text }` (plaintext or BYOK-encrypted, max 8000 chars). Returns `{ url }`. |
| `POST`  | `/api/notefade/read-note`   | Proxy to notefade read API. Body: `{ url }`. Returns `{ text }`.                                          |

Six REST endpoints. That's the entire backend.

**Rate limits**: Room creation is limited to 10 rooms per IP per minute. Notefade proxy is limited to 5 requests per IP per minute.

### WebSocket Protocol

Connect via `GET /ws/:roomId?cid={uuid}` with an `Upgrade: websocket` header. The `cid` is a per-tab UUID stored in `localStorage` per room (key `yapgone-client-id-{roomId}`); reconnects with the same `cid` are treated as resumes by the worker. If `cid` is omitted (legacy clients), the worker generates one server-side and resume support is disabled for that connection.

**Client → Server:**

| Type         | Fields                | Description                                                    |
| ------------ | --------------------- | -------------------------------------------------------------- |
| `pubkey`     | `key`                 | Send public key to relay during handshake                      |
| `message`    | `header`, `payload`   | Ratchet-encrypted broadcast message                            |
| `direct`     | `targetId`, `payload` | Encrypted message to a specific peer (sender key distribution) |
| `typing`     | `active`              | Typing indicator (boolean)                                     |
| `leave`      | —                     | Graceful departure; triggers `peer-left` to others             |
| `close-room` | —                     | Close room for everyone; triggers `room-closed` to all         |

**Server → Client:**

| Type           | Fields                    | Description                                                  |
| -------------- | ------------------------- | ------------------------------------------------------------ |
| `peer-joined`  | `clientId`, `clientCount` | A new peer connected                                         |
| `peer-left`    | `clientId`, `clientCount` | A peer disconnected or left                                  |
| `peer-list`    | `clientIds`, `yourId`     | Sent on connect: list of existing peers and your assigned ID |
| `room-full`    | —                         | Room has reached max participants                            |
| `room-expired` | —                         | Room expired due to inactivity                               |
| `room-closed`  | —                         | Room was explicitly closed by a participant                  |
| `error`        | `code`, `message`         | Error (rate limit, invalid JSON, message too large, etc.)    |

**Limits**: 60 messages per second per client. Maximum message size: 32 KB.

## 🏠 Self-Hosting

**Frontend:**

```bash
yarn build
# Serve the dist/ directory with any static file server
```

**Backend:**

```bash
yarn worker:deploy
```

Requires a Cloudflare account with:

- **Workers** — runs the relay logic
- **Durable Objects** — one `ChatRoom` instance per room
- **KV namespace** — stores invite shards (configure `INVITE_SHARDS` binding in `wrangler.toml`)

Update the `wrangler.toml` KV namespace ID and any other bindings before deploying.

## 🚀 Getting Started

**Prerequisites:**

- Node.js 20+
- Yarn Classic (`npm install -g yarn`)

**Development:**

```bash
# Install dependencies
yarn

# Start frontend + worker dev server (concurrent)
yarn dev

# Or run them separately:
yarn dev:fe        # Vite dev server only
yarn worker:dev    # Wrangler dev server only
```

**Build & Test:**

```bash
yarn build         # TypeScript check + Vite production build
yarn test          # Run tests once (Vitest)
yarn test:watch    # Run tests in watch mode
yarn typecheck     # TypeScript type checking only
```

**Note:** In development, Vite proxies API requests to the Wrangler dev server. The `VITE_API_URL` environment variable controls the API base URL.

## 🧰 Tech Stack

| Technology                 | Role                                              |
| -------------------------- | ------------------------------------------------- |
| React 19                   | UI framework                                      |
| TypeScript 5.7+ (strict)   | Type safety                                       |
| Vite 6                     | Build tool and dev server                         |
| CSS Modules                | Scoped component styling (no Tailwind)            |
| Web Crypto API             | All cryptographic operations (zero external deps) |
| WebSocket + WebRTC         | Real-time messaging and voice calls               |
| Cloudflare Workers         | Edge-deployed backend relay                       |
| Cloudflare Durable Objects | Per-room state and WebSocket management           |
| Cloudflare KV              | Invite shard storage (1h TTL)                     |
| Zod                        | Runtime schema validation                         |
| Vitest                     | Unit testing                                      |
| qrcode                     | QR code generation for invite links               |

## 📁 Project Structure

```
src/
├── api/            # Client-side API functions (REST + WebSocket URL builders)
├── components/     # React components
│   ├── error-boundary/
│   ├── layout/
│   └── ui/         # Chat input, message bubbles, voice controls, lightbox, etc.
├── constants/      # All limits and configuration constants
├── crypto/         # Cryptographic primitives
│   ├── buffer.ts       # ArrayBuffer compatibility helper
│   ├── ecdh.ts         # ECDH P-256 key generation and derivation
│   ├── encrypt.ts      # AES-256-GCM encrypt/decrypt
│   ├── group-key-exchange.ts  # Pairwise ratchets + sender key distribution
│   ├── kdf.ts          # HKDF, HMAC, KDF ratchet step
│   ├── keys.ts         # XOR split/combine, base64url encoding
│   ├── media-key.ts    # Media key derivation for WebRTC E2EE
│   ├── notefade-crypto.ts  # Notefade BYOK encryption and room-key derivation
│   ├── ratchet.ts      # Double ratchet protocol
│   ├── safety-number.ts  # Safety number computation
│   └── sender-keys.ts   # Sender key protocol (group encryption)
├── data/           # Static data
├── hooks/          # React hooks (chat, voice, WebSocket, crypto state)
├── pages/          # Page components (home, chat)
├── styles/         # Global CSS and CSS Modules
├── types/          # TypeScript type definitions
├── utils/          # Utility functions
├── workers/        # Web Workers (media crypto)
└── ws/             # WebSocket protocol types and Zod schemas

worker/
├── index.ts        # Cloudflare Worker entry (REST API routing)
├── chat-room.ts    # Durable Object (WebSocket relay, room lifecycle)
└── tsconfig.json   # Worker-specific TypeScript config

tests/
├── api/            # API function tests
├── components/     # Component tests
├── crypto/         # Cryptographic primitive tests
├── hooks/          # Hook tests
├── utils/          # Utility tests
├── workers/        # Web Worker tests
└── ws/             # WebSocket protocol tests
```

## 📄 License

MIT — Sascha Majewsky
