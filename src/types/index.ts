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
  | { kind: 'voice-request' }
  | { kind: 'voice-accept' }
  | { kind: 'voice-decline' }
  | { kind: 'sdp-offer'; sdp: string }
  | { kind: 'sdp-answer'; sdp: string }
  | { kind: 'ice-candidate'; candidate: string }
  | { kind: 'voice-end' }
  | { kind: 'screen-share-start' }
  | { kind: 'screen-share-stop' }

export type CallState =
  | 'idle'
  | 'requesting'
  | 'ringing'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'failed'
