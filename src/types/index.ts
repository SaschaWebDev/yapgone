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
  | { mode: 'chat'; roomId: string; creatorPubKey: string }
