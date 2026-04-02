import type { RoomSettings } from '@/room-settings'

export interface RatchetState {
  dhKeyPair: CryptoKeyPair
  remotePubKey: CryptoKey | null
  rootKey: Uint8Array

  sendChainKey: Uint8Array
  sendMessageNumber: number

  recvChainKey: Uint8Array | null
  recvMessageNumber: number

  prevSendChainLength: number
  skippedMessageKeys: Map<string, Uint8Array>
}

export type AppRoute =
  | { mode: 'home' }
  | { mode: 'chat'; roomId: string; creatorPubKey: string; roomSettings: RoomSettings | null }

export type VoiceSignal =
  | { kind: 'voice-request'; targetPeerId?: string }
  | { kind: 'voice-accept' }
  | { kind: 'voice-decline' }
  | { kind: 'sdp-offer'; sdp: string }
  | { kind: 'sdp-answer'; sdp: string }
  | { kind: 'ice-candidate'; candidate: string }
  | { kind: 'voice-end' }
  | { kind: 'screen-share-start' }
  | { kind: 'screen-share-stop' }
  | { kind: 'video-start' }
  | { kind: 'video-stop' }
  | { kind: 'e2ee-toggle'; e2ee: boolean }
  | { kind: 'e2ee-downgrade-request' }
  | { kind: 'e2ee-downgrade-accept' }
  | { kind: 'e2ee-downgrade-decline' }

export type GroupVoiceSignal =
  | { kind: 'group-voice-join' }
  | { kind: 'group-voice-leave' }
  | { kind: 'group-voice-key'; key: string }

export type CallState =
  | 'idle'
  | 'requesting'
  | 'ringing'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'failed'

export interface PeerInfo {
  clientId: string
  pubKey: CryptoKey | null
  pubKeyRaw: Uint8Array | null
  username: string | null
}

export interface GroupCryptoState {
  myId: string
  myPubKeyRaw: Uint8Array
  peerRatchets: Map<string, RatchetState>
  peers: Map<string, PeerInfo>
}
