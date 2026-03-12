/* eslint-disable @typescript-eslint/no-empty-object-type */

interface RTCEncodedAudioFrame {
  readonly timestamp: number
  data: ArrayBuffer
  getMetadata(): Record<string, unknown>
}

interface RTCEncodedVideoFrame {
  readonly timestamp: number
  readonly type: 'key' | 'delta' | 'empty'
  data: ArrayBuffer
  getMetadata(): Record<string, unknown>
}

interface RTCInsertableStreams {
  readonly readable: ReadableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>
  readonly writable: WritableStream<RTCEncodedAudioFrame | RTCEncodedVideoFrame>
}

interface RTCRtpSender {
  createEncodedStreams(): RTCInsertableStreams
}

interface RTCRtpReceiver {
  createEncodedStreams(): RTCInsertableStreams
}

interface RTCConfiguration {
  encodedInsertableStreams?: boolean
}
