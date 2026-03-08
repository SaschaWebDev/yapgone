# Architecture: Notefade Chat

Deep technical reference for the encrypted real-time chat system. This document is self-contained — everything needed to implement the system is described here.

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Cryptographic Primitives](#cryptographic-primitives)
3. [Key Exchange](#key-exchange)
4. [Double Ratchet Protocol](#double-ratchet-protocol)
5. [Per-Message Encryption](#per-message-encryption)
6. [Session Lifecycle](#session-lifecycle)
7. [Server Relay Design](#server-relay-design)
8. [Wire Protocol](#wire-protocol)
9. [Data Flow Diagrams](#data-flow-diagrams)
10. [Byte-Size Reference](#byte-size-reference)
11. [Threat Model](#threat-model)
12. [Key Splitting (XOR vs Shamir)](#key-splitting)
13. [v2: Dual-Channel XOR Ciphertext Splitting](#dual-channel-xor-ciphertext-splitting-v2-defense-against-traffic-recording)
14. [v2: Cover Traffic (Chaff Messages)](#cover-traffic-chaff-messages-v2-metadata-resistance)

---

## System Overview

Notefade Chat provides ephemeral, end-to-end encrypted 1-to-1 chat over WebSockets. The server is a stateless relay that forwards encrypted blobs between participants. It never sees plaintext, never stores messages, and never possesses encryption keys.

```
┌──────────┐    WebSocket     ┌─────────────────┐    WebSocket     ┌──────────┐
│  Alice    │◄───(encrypted)──►│  Cloudflare DO   │◄───(encrypted)──►│   Bob    │
│  Browser  │                  │  (relay only)    │                  │  Browser │
│           │                  │                  │                  │          │
│ - ECDH    │                  │ - forwards blobs │                  │ - ECDH   │
│ - Ratchet │                  │ - manages room   │                  │ - Ratchet│
│ - AES-GCM │                  │ - TTL cleanup    │                  │ - AES-GCM│
└──────────┘                  └─────────────────┘                  └──────────┘
```

**Zero-knowledge guarantee:** The server handles only opaque byte arrays. Even if the server is fully compromised (logs every byte), the attacker gets ciphertext, public keys, and nothing else. Deriving the shared secret requires the private key, which never leaves the browser.

---

## Cryptographic Primitives

All operations use the **Web Crypto API** (`crypto.subtle`). Zero external dependencies.

### ECDH (Key Agreement)
- **Curve:** P-256 (secp256r1 / prime256v1)
- **API:** `crypto.subtle.generateKey("ECDH", ...)` and `crypto.subtle.deriveBits("ECDH", ...)`
- **Output:** 256-bit (32-byte) shared secret from `deriveBits`
- **Why P-256:** Universal browser support. X25519 is preferable in theory (faster, simpler, constant-time by design) but Web Crypto support for X25519 is still inconsistent across browsers. P-256 is well-audited, NIST-approved, and sufficient for this threat model. Revisit when X25519 is universally available.

```typescript
// Key generation
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,  // extractable (need to export public key)
  ["deriveBits"]
);

// Export public key (for sending to peer)
const pubKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
// → 65 bytes: 0x04 || X (32 bytes) || Y (32 bytes)

// Derive shared secret
const sharedBits = await crypto.subtle.deriveBits(
  { name: "ECDH", public: peerPublicKey },
  keyPair.privateKey,
  256  // 32 bytes
);
```

### AES-256-GCM (Symmetric Encryption)
- **Key size:** 256 bits (32 bytes)
- **IV size:** 96 bits (12 bytes), randomly generated per message
- **Tag size:** 128 bits (16 bytes), appended to ciphertext by Web Crypto
- **API:** `crypto.subtle.encrypt("AES-GCM", ...)` and `crypto.subtle.decrypt("AES-GCM", ...)`

### HKDF (Key Derivation)
- **Hash:** SHA-256
- **API:** `crypto.subtle.deriveBits("HKDF", ...)`
- **Usage:** Derives ratchet chain keys and message keys from the ECDH shared secret and chain state.

```typescript
// Import raw key material for HKDF
const hkdfKey = await crypto.subtle.importKey(
  "raw", inputKeyMaterial, "HKDF", false, ["deriveBits"]
);

// Derive 256-bit key
const derived = await crypto.subtle.deriveBits(
  { name: "HKDF", hash: "SHA-256", salt: salt, info: info },
  hkdfKey,
  256
);
```

### HMAC (Message Authentication for Ratchet Chains)
- **Hash:** SHA-256
- **API:** `crypto.subtle.sign("HMAC", ...)` and `crypto.subtle.importKey(..., "HMAC", ...)`
- **Usage:** Advancing the symmetric ratchet chain (KDF chain).

---

## Key Exchange

### Initial Key Exchange (Room Creation)

```
1. Alice (creator):
   - Generates ECDH key pair (P-256)
   - Creates room via HTTP POST → server returns roomID
   - Builds invite URL: notefade.com/chat#<roomID>:<base64url(alicePubKey)>
   - Connects to WebSocket at /ws/<roomID>
   - Waits for Bob

2. Bob (joiner):
   - Opens invite URL
   - Extracts roomID and alicePubKey from URL fragment
   - Generates own ECDH key pair
   - Connects to WebSocket at /ws/<roomID>
   - Sends own public key over WebSocket: { type: "pubkey", key: bobPubKeyRaw }
   - Server relays Bob's pubkey message to Alice

3. Both sides:
   - Perform ECDH: sharedSecret = ECDH(ownPrivate, peerPublic)
   - Derive root key via HKDF: rootKey = HKDF(sharedSecret, salt="notefade-chat-root", info="")
   - Initialize Double Ratchet state with rootKey
```

**Key insight:** Alice's public key travels in the URL fragment (never sent to server). Bob's public key travels over WebSocket (server sees it but can't use it without a private key). The ECDH shared secret is computed client-side only.

### Why Not Use a Separate Key Server?
Adding a key server would add trust requirements and complexity. The WebSocket relay already provides a message channel. The public key exchange happens in-band — Alice's key via URL fragment, Bob's key via WebSocket relay. No additional server infrastructure needed.

---

## Double Ratchet Protocol

The Double Ratchet provides forward secrecy and break-in recovery. It combines two ratchet mechanisms:

### 1. Symmetric-Key Ratchet (KDF Chain)

Each side maintains a **sending chain** and a **receiving chain**. Each chain step produces a **message key** (used once for one message) and advances the **chain key**.

```
Chain Key (CK_n) ──HMAC──► Chain Key (CK_n+1)
                  └──HMAC──► Message Key (MK_n)

Specifically:
  CK_n+1 = HMAC-SHA256(CK_n, 0x01)
  MK_n   = HMAC-SHA256(CK_n, 0x02)
```

- Message keys are used exactly once, then discarded.
- Chain keys are replaced after each step, then the old chain key is discarded.
- This provides **forward secrecy within a chain**: compromising CK_n reveals MK_n, MK_n+1, ... but NOT MK_0 through MK_n-1.

### 2. Diffie-Hellman Ratchet

Periodically (typically on each reply), the sender generates a **new ECDH key pair** and includes the new public key in the message header. The recipient uses this to perform a new ECDH derivation, which resets the KDF chains.

```
Alice sends message:
  - Generates new ECDH key pair (ephemeralA2)
  - DH output = ECDH(ephemeralA2.private, bobCurrentPublic)
  - New root key + new sending chain key = HKDF(currentRootKey, DH output)
  - Encrypts message with next message key from new sending chain
  - Sends: { header: { pubkey: ephemeralA2.public, N: msgNumber, PN: prevChainLength }, ciphertext }

Bob receives:
  - Performs ECDH(bobCurrentPrivate, ephemeralA2.public) → same DH output
  - Derives same new root key + new receiving chain key
  - Decrypts message
  - On next send: Bob generates new key pair, performs DH ratchet step
```

This provides **break-in recovery**: even if an attacker compromises a chain key, the next DH ratchet step derives completely new chain keys that the attacker cannot compute (they'd need the new private key).

### Ratchet State

Each participant maintains:

```typescript
interface RatchetState {
  // DH ratchet
  dhKeyPair: CryptoKeyPair;           // Current ECDH key pair
  remotePubKey: CryptoKey;             // Peer's latest public key
  rootKey: Uint8Array;                 // 32 bytes — root chain key

  // Sending chain
  sendChainKey: Uint8Array;            // 32 bytes — current sending CK
  sendMessageNumber: number;           // N_s — messages sent in current chain

  // Receiving chain
  recvChainKey: Uint8Array;            // 32 bytes — current receiving CK
  recvMessageNumber: number;           // N_r — messages received in current chain

  // Out-of-order handling
  prevSendChainLength: number;         // PN — length of previous sending chain
  skippedMessageKeys: Map<string, Uint8Array>;  // (pubkey, N) → MK for out-of-order messages
}
```

### Out-of-Order Messages

Messages may arrive out of order due to network conditions. When a DH ratchet step occurs, the recipient must:
1. Check if the message's public key matches the current remote public key.
2. If not, perform the DH ratchet step first.
3. If the message number (N) is ahead of expected, store the skipped message keys for later decryption.
4. Cap the number of stored skipped keys (e.g., max 100) to prevent memory exhaustion attacks.

---

## Per-Message Encryption

Each message is encrypted with AES-256-GCM using the message key derived from the current ratchet chain.

### Message Envelope (Sent Over WebSocket)

```
┌─────────────────────────────────────────────────┐
│ Header (plaintext — visible to server)          │
│  ├─ type: "message"                             │
│  ├─ senderPubKey: Uint8Array (65 bytes)         │
│  │    → current DH ratchet public key           │
│  ├─ N: number                                   │
│  │    → message number in current sending chain  │
│  └─ PN: number                                  │
│       → previous chain length (for ratchet sync) │
├─────────────────────────────────────────────────┤
│ Encrypted Payload                               │
│  ├─ IV: Uint8Array (12 bytes)                   │
│  ├─ ciphertext: Uint8Array (variable)           │
│  │    → AES-256-GCM(messageKey, IV, plaintext)  │
│  └─ tag: Uint8Array (16 bytes)                  │
│       → GCM auth tag (appended by Web Crypto)   │
├─────────────────────────────────────────────────┤
│ Additional Authenticated Data (AAD)             │
│  └─ header bytes (authenticated but not encryp.) │
└─────────────────────────────────────────────────┘
```

**AAD:** The header (sender public key, N, PN) is included as Additional Authenticated Data in the AES-GCM encryption. This means the header is **not encrypted** (the server can see public keys and message numbers) but it **is authenticated** (tampering with the header causes decryption to fail).

### Why Header Is Not Encrypted
- The server needs to relay messages but doesn't need to understand them. The header contains only public keys (useless without private keys) and counters (metadata, not content).
- Encrypting the header would require a separate shared key just for header encryption, adding complexity with minimal security gain for this threat model.
- The AAD binding ensures integrity — if the server tampers with the header, the recipient's decryption fails.

---

## Session Lifecycle

```
┌────────────────────────────────────────────────────────────────────┐
│ Phase 1: Room Creation                                            │
│                                                                    │
│  Alice ──POST /api/rooms──► Worker ──creates──► Durable Object    │
│  Alice ◄──{ roomID }──────── Worker                               │
│  Alice builds URL: /chat#<roomID>:<base64url(pubKey)>             │
│  Alice ──WebSocket──► Durable Object (waits for peer)             │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Phase 2: Join & Key Exchange                                       │
│                                                                    │
│  Bob opens URL → extracts roomID + Alice's pubKey from fragment   │
│  Bob ──WebSocket──► Durable Object                                │
│  Bob ──{ type: "pubkey", key: bobPubKey }──► DO ──relay──► Alice  │
│  Both compute: sharedSecret = ECDH(ownPrivate, peerPublic)        │
│  Both initialize Double Ratchet with HKDF(sharedSecret)           │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Phase 3: Encrypted Chat                                            │
│                                                                    │
│  Each message:                                                     │
│    Sender: ratchet step → derive MK → AES-GCM encrypt → send     │
│    Server: relay encrypted blob (cannot decrypt)                   │
│    Receiver: ratchet step → derive MK → AES-GCM decrypt → display│
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Phase 4: Session End                                               │
│                                                                    │
│  Triggered by:                                                     │
│    - Both participants disconnect                                  │
│    - Inactivity timeout (configurable, default 30 min)             │
│    - Explicit "end chat" action                                    │
│  Durable Object:                                                   │
│    - Closes all WebSocket connections                              │
│    - Deletes all in-memory state                                   │
│    - Alarm-based self-cleanup                                      │
│  Client:                                                           │
│    - Zeroes ratchet state (best-effort)                            │
│    - Clears message list from memory                               │
│    - Shows "conversation has faded" screen                         │
└────────────────────────────────────────────────────────────────────┘
```

### Room Capacity
- **MVP:** 2 participants per room (1-to-1). Durable Object rejects third connection.
- **Future:** Group chat requires Sender Keys or pairwise ratchets. Architecture should not prevent this but MVP does not implement it.

### Reconnection Policy (MVP)
- If a participant disconnects and reconnects, ratchet state in the browser is lost (memory-only).
- The session is considered broken. The reconnecting participant sees a "session expired" message.
- For v2: consider storing ratchet state in `sessionStorage` (survives page refresh within the same tab) with explicit security tradeoff acknowledgment.

---

## Server Relay Design

### Cloudflare Worker (Entry Point)

The Worker handles:
1. **`POST /api/rooms`** — Creates a new Durable Object instance, returns `{ roomID }`.
2. **`GET /ws/:roomID`** — Upgrades to WebSocket, routes to the Durable Object for that room.
3. **CORS headers** — Allow requests from the frontend origin.

The Worker is stateless. All per-room state lives in the Durable Object.

### Durable Object (Chat Room)

```typescript
// Conceptual structure — not exact implementation
class ChatRoom implements DurableObject {
  state: DurableObjectState;
  clients: Map<WebSocket, { id: string }>;  // max 2 for MVP
  inactivityAlarm: boolean;

  async fetch(request: Request): Promise<Response> {
    // Handle WebSocket upgrade
    // Reject if room is full (2 clients)
    // Add client to map
    // Set inactivity alarm
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    // Relay message to all OTHER connected clients
    // Reset inactivity alarm
    // Do NOT inspect, log, or store the message content
  }

  async webSocketClose(ws: WebSocket) {
    // Remove client from map
    // If no clients remain, set short cleanup alarm
    // If one client remains, notify them peer disconnected
  }

  async alarm() {
    // Close all connections
    // Delete all state
    // Durable Object will be garbage collected
  }
}
```

### What the Server Stores
| Data | Duration | Purpose |
|------|----------|---------|
| Room ID → DO mapping | While room exists | Route WebSocket to correct DO |
| Connected client list | While connected | Know where to relay messages |
| Inactivity timer | While room exists | Auto-cleanup |
| **Messages** | **NEVER** | **Server never stores messages** |
| **Keys** | **NEVER** | **Server never stores private keys or shared secrets** |

### Rate Limiting
- Room creation: rate-limit by IP (e.g., 10 rooms per minute per IP).
- WebSocket messages: rate-limit per connection (e.g., 60 messages per second). Prevents abuse while allowing fast typing.
- Implemented at the Worker level (not Durable Object) for efficiency.

---

## Wire Protocol

All WebSocket messages are JSON-serialized (for MVP simplicity). Binary framing is a v2 optimization.

### Message Types

```typescript
// Client → Server → Client (relayed)
type WsMessage =
  | { type: "pubkey"; key: string }           // base64url-encoded raw public key (65 bytes)
  | { type: "message"; header: MessageHeader; payload: string }  // base64url-encoded encrypted blob
  | { type: "typing"; active: boolean }       // typing indicator (plaintext, acceptable metadata leak)
  | { type: "leave" }                         // explicit disconnect notification

// Server → Client (server-originated)
type WsServerMessage =
  | { type: "peer-joined" }                   // peer connected to room
  | { type: "peer-left" }                     // peer disconnected
  | { type: "room-full" }                     // room already has 2 participants
  | { type: "room-expired" }                  // TTL reached, room closing
  | { type: "error"; code: string; message: string }

interface MessageHeader {
  pubkey: string;   // base64url — sender's current DH ratchet public key
  n: number;        // message number in current sending chain
  pn: number;       // previous chain length
}
```

### Serialization
- Public keys: `raw` export format → base64url encoding
- Encrypted payloads: `IV (12 bytes) || ciphertext || tag (16 bytes)` → base64url encoding
- Message headers: JSON object, included as AAD during encryption

---

## Byte-Size Reference

| Item | Size | Notes |
|------|------|-------|
| ECDH P-256 private key | 32 bytes | Never leaves browser |
| ECDH P-256 public key (raw, uncompressed) | 65 bytes | 0x04 prefix + 32B X + 32B Y |
| ECDH shared secret | 32 bytes | Output of deriveBits |
| AES-256-GCM key | 32 bytes | Derived from ratchet chain |
| AES-256-GCM IV/nonce | 12 bytes | Random per message |
| AES-256-GCM auth tag | 16 bytes | Appended to ciphertext |
| HKDF salt | 32 bytes | Random, generated at session init |
| Root key | 32 bytes | Derived via HKDF |
| Chain key | 32 bytes | Derived via HMAC |
| Message key | 32 bytes | Derived via HMAC, used once |
| Ratchet state (total in memory) | ~300-500 bytes | Plus skipped key storage |
| Encrypted message overhead | 28 bytes | 12B IV + 16B tag (fixed) + ciphertext (variable) |
| Message header overhead | ~120 bytes | JSON with base64url pubkey + counters |

### URL Fragment Size
```
Room ID:    ~12 characters (nanoid or similar)
Separator:  1 character (:)
Public key: ~88 characters (65 bytes base64url)
Total:      ~101 characters — well within URL limits
```

---

## Threat Model

### What We Protect Against

| Threat | Mitigation |
|--------|-----------|
| Server reads messages | E2E encryption — server only sees ciphertext |
| Server logs all traffic | Ciphertext without keys is useless |
| Server tampers with messages | AAD binding — header modification causes decryption failure |
| Network eavesdropper (passive) | ECDH + TLS double layer |
| Compromise of one message key | Forward secrecy — each message has a unique key derived from ratchet chain |
| Compromise of current chain key | Break-in recovery — next DH ratchet step derives new chain keys |
| Replay attacks | Message numbers (N) + GCM nonce uniqueness |
| Room ID brute-force | Sufficiently long random room IDs (~12 chars, 64-bit entropy minimum) |
| Traffic recording + future key compromise (v2) | Dual-Channel XOR Ciphertext Splitting — server only sees one XOR share, full ciphertext is irrecoverable without the P2P share |
| Timing/frequency metadata analysis (v2) | Cover Traffic (Chaff Messages) — constant-rate, constant-size message stream makes real and dummy messages indistinguishable |

### What We Do NOT Protect Against (Known Limitations)

| Threat | Why |
|--------|-----|
| Compromised endpoint (malware on device) | Browser has full access to plaintext. No defense in web apps. |
| Screenshots / copy-paste | Cannot prevent. Be honest about this. |
| Participant extracting keys from devtools | Expected — they already see the plaintext. |
| Metadata analysis (who talks to whom, when, message sizes) | Server sees connection times and encrypted message sizes. WebSocket connections reveal timing. Mitigation: Cover Traffic mode (v2) — see dedicated section below. |
| Active MITM during key exchange | If the server actively replaces public keys during relay, it can MITM. Mitigation: Safety Number verification (display a fingerprint derived from both public keys that participants can compare out-of-band). Implement in v2. |
| Denial of service | Server can drop messages or refuse connections. Out of scope for E2E encryption — operational concern. |

### Trust Assumptions
1. **The Web Crypto API implementation is correct.** We trust the browser's crypto primitives.
2. **The browser is not compromised.** A malicious browser extension could read plaintext.
3. **TLS is functioning.** We assume the HTTPS connection between browser and server is not compromised.
4. **The server is honest-but-curious for MVP.** It follows the protocol but may try to read data. It does NOT actively modify messages (no active MITM). Safety Number verification (v2) addresses this.

---

## Key Splitting

### XOR Splitting (Used for Invite Links)

For the invite link, the creator's ECDH public key is split using XOR:
- One share goes in the URL fragment
- One share is sent to the server when creating the room

This ensures that neither the URL alone (intercepted by a link previewer, browser history, etc.) nor the server alone can recover the full public key.

```
publicKeyBytes = 65 bytes
serverShare    = crypto.getRandomValues(new Uint8Array(65))
urlShare       = publicKeyBytes XOR serverShare

// Reconstruction:
publicKeyBytes = urlShare XOR serverShare
```

**Why XOR, not Shamir:** For 2-of-2 splitting, XOR is information-theoretically secure and has zero computational overhead. Shamir's Secret Sharing is only needed for t-of-n schemes where t < n.

### Shamir Secret Sharing (Future: Group Chat)

For group chat (v2), a session key could be split into n shares where any t participants can reconstruct it. This enables:
- Resilience against t-1 participants colluding
- Participants can join/leave without re-keying the entire group

**Not implemented in MVP.** The architecture documents it here for future reference.

Implementation note: Shamir over GF(256) can be implemented with Web Crypto API primitives (it's just polynomial evaluation over a finite field) but it's more complex than XOR. Consider carefully whether the complexity is warranted — for most group chat scenarios, pairwise ratchets (like Signal's Sender Keys) may be simpler and provide better forward secrecy properties.

### Dual-Channel XOR Ciphertext Splitting (v2: Defense Against Traffic Recording)

**Threat addressed:** An attacker records all relay traffic today, then later compromises a client and extracts ratchet keys. With standard E2E encryption, they can decrypt the recorded ciphertext retroactively.

**Solution:** After AES-256-GCM encryption, XOR-split the ciphertext itself into two shares and send each share over an **independent channel**. The relay server only ever sees one share — information-theoretically random noise without the other.

```
Plaintext
    │
    ▼
AES-256-GCM encrypt (Double Ratchet message key)
    │
    ▼
Ciphertext (IV + encrypted + tag)
    │
    ├──XOR split──►  Share A ──► Channel 1 (WebSocket relay)
    │
    └──XOR split──►  Share B ──► Channel 2 (WebRTC P2P data channel)

Recipient:
    Share A + Share B ──XOR──► Ciphertext ──AES-GCM decrypt──► Plaintext
```

**Critical requirement:** The two channels MUST be independent. If both shares pass through the same relay, the server can trivially XOR them together to recover the full ciphertext.

**Channel options:**

| Channel 2 Option | Pros | Cons |
|-------------------|------|------|
| **WebRTC data channel** | True P2P — no server sees share B. Best security. | Requires STUN/TURN for NAT traversal. Can be blocked by firewalls. Adds infrastructure dependency. |
| **Second relay server** | Simpler than WebRTC. Works through firewalls. | Must trust that relay 1 and relay 2 don't collude. Doubles server infrastructure. |
| **Per-message shard in KV** (Notefade-style) | Familiar pattern. One share relayed, one stored briefly in KV and fetched separately. | Adds latency per message. Server briefly stores shards (contradicts "stores nothing"). KV eventual consistency adds delay. |

**Tradeoffs:**
- Doubles bandwidth (every message is sent twice, effectively).
- Adds latency (WebRTC setup, or KV fetch per message).
- WebRTC fallback needed when P2P fails (fall back to single-channel AES-only).
- Significantly more complex implementation.

**Security gain:** Even with full relay traffic recording + future key compromise, the attacker only has one XOR share of each message. Without the other share (which traveled P2P and was never on any server), the ciphertext is information-theoretically irrecoverable. This is a strict upgrade over AES-256-GCM alone for the traffic-recording threat model.

**Recommendation:** Implement as a v2 "enhanced privacy" mode. The WebRTC data channel is the best Channel 2 option (true P2P, no server involvement). Fall back to standard single-channel AES-GCM when WebRTC is unavailable. This makes dual-channel a progressive enhancement, not a hard requirement.

---

## Cover Traffic / Chaff Messages (v2: Metadata Resistance)

### The Problem

Even with perfect E2E encryption, the server learns metadata:
- **When** participants are active (message timestamps)
- **How often** they talk (message frequency)
- **How much** they say (message sizes)
- **Who responds to whom** (timing correlation between send and receive)

A server (or network observer) can build behavioral profiles without ever reading a single word. This is the same class of metadata that intelligence agencies use for traffic analysis.

### The Solution: Constant-Rate Chaff

Both participants agree to send messages at a **fixed interval** (e.g., every 2 seconds), regardless of whether they have something to say. When there's nothing to send, a **chaff message** (dummy) is sent instead. All messages — real and chaff — are **padded to an identical fixed size**.

The real/chaff distinction is **inside the encrypted payload**. The server cannot tell the difference.

```
Every 2 seconds, each participant:

  Has real message?
    YES → encrypt( 0x01 || pad(realMessage, BLOCK_SIZE) )  → send
    NO  → encrypt( 0x00 || randomBytes(BLOCK_SIZE) )       → send
                     ↑
           flag is INSIDE the AES-256-GCM ciphertext
           server sees identical-looking blobs either way

Recipient decrypts:
    First byte == 0x01  →  strip padding, display message
    First byte == 0x00  →  discard silently
```

### What the Server Sees

**Without cover traffic (MVP):**
```
Timeline:  ──────────────────────────────────────────────────►
Alice:     msg...msg.msg......................msg.msg..........
Bob:       .......msg...msg.............................msg....
                                ↑
                    "They stopped talking at 2am"
                    "Alice sends ~3x more than Bob"
                    "Average response time: 8 seconds"
```

**With cover traffic (v2):**
```
Timeline:  ──────────────────────────────────────────────────►
Alice:     ##.##.##.##.##.##.##.##.##.##.##.##.##.##.##.##.##
Bob:       ##.##.##.##.##.##.##.##.##.##.##.##.##.##.##.##.##
                                ↑
                    Every blob is the same size
                    Every interval has exactly one blob
                    Server learns: nothing
```

### Protocol Design

#### Negotiation

Cover traffic mode is negotiated **inside the encrypted channel** during session setup. The server does not know which mode the participants chose.

```typescript
// Sent encrypted after Double Ratchet initialization
interface SessionConfig {
  coverTraffic: boolean;          // enable chaff messages
  intervalMs: number;             // send interval (e.g., 2000ms)
  blockSize: number;              // fixed payload size in bytes (e.g., 1024)
}
```

Both participants must agree on the same `intervalMs` and `blockSize`. If they disagree, fall back to the sender's config (recipient adapts).

#### Message Format (Cover Traffic Mode)

```
┌─────────────────────────────────────────────────────────────┐
│ Fixed-size encrypted payload (blockSize + overhead)         │
│                                                             │
│  After decryption:                                          │
│  ┌──────────┬──────────────────────────────────────────┐    │
│  │ flag     │ content                                  │    │
│  │ (1 byte) │ (blockSize - 1 bytes)                    │    │
│  ├──────────┼──────────────────────────────────────────┤    │
│  │ 0x01     │ realMessage || 0x00 padding              │    │
│  │ 0x00     │ random bytes (chaff)                     │    │
│  └──────────┴──────────────────────────────────────────┘    │
│                                                             │
│  Padding scheme:                                            │
│    Real messages are null-terminated, then padded with      │
│    random bytes to fill blockSize - 1.                      │
│    Random padding (not zero-fill) prevents the server from  │
│    distinguishing real from chaff by encrypted block         │
│    entropy analysis.                                        │
└─────────────────────────────────────────────────────────────┘
```

#### Timing

```typescript
// Conceptual client-side loop
const interval = setInterval(async () => {
  const pending = messageQueue.shift();

  if (pending) {
    // Real message — encrypt with flag 0x01
    const padded = padToBlockSize(new Uint8Array([0x01, ...encode(pending)]), BLOCK_SIZE);
    const encrypted = await ratchet.encrypt(padded);
    ws.send(encrypted);
  } else {
    // Chaff — encrypt with flag 0x00
    const chaff = new Uint8Array(BLOCK_SIZE);
    chaff[0] = 0x00;
    crypto.getRandomValues(chaff.subarray(1));
    const encrypted = await ratchet.encrypt(chaff);
    ws.send(encrypted);
  }
}, INTERVAL_MS);
```

**Important:** Real messages wait for the next interval slot. This introduces up to `INTERVAL_MS` latency on every message. At 2000ms interval, average added latency is 1 second. This is the tradeoff for metadata privacy.

#### Block Size Selection

| Block Size | Max Message | Bandwidth (2s interval) | Notes |
|------------|-------------|------------------------|-------|
| 256 bytes | 255 chars | ~128 B/s per participant | Tight — long messages need fragmentation |
| 512 bytes | 511 chars | ~256 B/s per participant | Good for typical chat messages |
| 1024 bytes | 1023 chars | ~512 B/s per participant | Comfortable — covers most messages |
| 2048 bytes | 2047 chars | ~1024 B/s per participant | Generous — wastes bandwidth on short messages |

For messages exceeding `blockSize - 1`, fragment across multiple intervals. The recipient reassembles. Fragmentation header (2 bytes: fragment index + total fragments) reduces effective content size slightly.

### Combining with Dual-Channel XOR Splitting

Cover traffic and dual-channel splitting are **orthogonal** and can be layered:

```
Every interval:
  1. Compose payload (real message with 0x01 flag, or chaff with 0x00 flag)
  2. Pad to fixed block size
  3. AES-256-GCM encrypt with current ratchet message key
  4. XOR-split ciphertext into Share A + Share B
  5. Send Share A over WebSocket relay
  6. Send Share B over WebRTC P2P

Result:
  - Server sees constant-rate, constant-size blobs (cover traffic)
  - Server only has one XOR share of each blob (dual-channel)
  - Even with traffic recording + key compromise: nothing recoverable
  - Even with metadata analysis: nothing distinguishable
```

This combination provides the strongest possible protection for a browser-based chat system:
- **Content privacy:** AES-256-GCM + Double Ratchet (forward secrecy, break-in recovery)
- **Ciphertext privacy:** XOR split across independent channels (server never sees full ciphertext)
- **Metadata privacy:** Cover traffic (server can't distinguish activity from silence)

### Tradeoffs Summary

| Cost | Standard Mode (MVP) | Cover Traffic (v2) | Cover + Dual-Channel (v2) |
|------|---------------------|--------------------|-----------------------------|
| Bandwidth | Variable, on-demand | Constant ~512 B/s per participant | Constant ~1024 B/s per participant |
| Latency | Immediate send | Up to INTERVAL_MS delay | Up to INTERVAL_MS delay + WebRTC overhead |
| CPU | Encrypt on send only | Encrypt every interval | Encrypt + XOR split every interval |
| Battery | Idle when silent | Always active | Always active + WebRTC |
| Server cost | Pay per message | Pay per interval (constant) | Pay per interval + STUN/TURN |
| Metadata leaked | Timing, frequency, sizes | Nothing | Nothing |

### Recommendation

Implement as an opt-in **"Stealth Mode"** toggle in the chat UI. Users who need metadata resistance enable it. Users who prefer lower latency and battery usage stay on standard mode. The mode is negotiated inside the encrypted channel — the server does not know which mode is active.

Default to standard mode for MVP. Surface stealth mode as a v2 feature with clear UX explaining the tradeoffs ("messages may be slightly delayed, uses more battery").
