export function xorSplit(data: Uint8Array): { share1: Uint8Array; share2: Uint8Array } {
  const share1 = crypto.getRandomValues(new Uint8Array(data.length))
  const share2 = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    share2[i] = (data[i] ?? 0) ^ (share1[i] ?? 0)
  }
  return { share1, share2 }
}

export function xorCombine(share1: Uint8Array, share2: Uint8Array): Uint8Array {
  if (share1.length !== share2.length) {
    throw new Error('Shares must have equal length')
  }
  const result = new Uint8Array(share1.length)
  for (let i = 0; i < share1.length; i++) {
    result[i] = (share1[i] ?? 0) ^ (share2[i] ?? 0)
  }
  return result
}

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]

    result += BASE64URL_CHARS[b0 >> 2]
    result += BASE64URL_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]

    if (b1 !== undefined) {
      result += BASE64URL_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    } else {
      break
    }

    if (b2 !== undefined) {
      result += BASE64URL_CHARS[b2 & 0x3f]
    }
  }
  return result
}

export function fromBase64Url(str: string): Uint8Array {
  const lookup = new Uint8Array(128)
  for (let i = 0; i < BASE64URL_CHARS.length; i++) {
    lookup[BASE64URL_CHARS.charCodeAt(i)] = i
  }

  const length = Math.floor((str.length * 3) / 4)
  const bytes = new Uint8Array(length)

  let byteIndex = 0
  for (let i = 0; i < str.length; i += 4) {
    const a = lookup[str.charCodeAt(i)] ?? 0
    const b = lookup[str.charCodeAt(i + 1)] ?? 0
    const c = lookup[str.charCodeAt(i + 2)] ?? 0
    const d = lookup[str.charCodeAt(i + 3)] ?? 0

    bytes[byteIndex++] = (a << 2) | (b >> 4)
    if (byteIndex < length) bytes[byteIndex++] = ((b & 0x0f) << 4) | (c >> 2)
    if (byteIndex < length) bytes[byteIndex++] = ((c & 0x03) << 6) | d
  }

  return bytes
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const arr of arrays) {
    totalLength += arr.length
  }
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}
