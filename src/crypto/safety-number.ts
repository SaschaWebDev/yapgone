import { buf } from './buffer'
import { concatBytes } from './keys'

/**
 * Compares two Uint8Arrays lexicographically (byte-by-byte).
 * Returns negative if a < b, positive if a > b, zero if equal.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

/**
 * Converts the first 24 bytes of a SHA-256 hash into 60 decimal digits.
 * Processes 12 groups of 2 bytes each; each group yields a 5-digit
 * zero-padded decimal string (value range 0–65535).
 */
function hashToDigits(hash: Uint8Array): string {
  let result = ''
  for (let i = 0; i < 12; i++) {
    const b0 = hash[i * 2] ?? 0
    const b1 = hash[i * 2 + 1] ?? 0
    const value = (b0 << 8) | b1
    result += value.toString().padStart(5, '0')
  }
  return result
}

/**
 * Computes a pairwise Safety Number from two public keys.
 *
 * The keys are sorted lexicographically then concatenated and hashed
 * with SHA-256.  The resulting 32-byte digest is converted into a
 * 60-digit decimal string that both peers can compare to detect MITM
 * attacks (similar to Signal's Safety Number verification).
 */
export async function computePairwiseSafetyNumber(
  myPubKey: Uint8Array,
  peerPubKey: Uint8Array,
): Promise<string> {
  const [first, second] = compareBytes(myPubKey, peerPubKey) <= 0
    ? [myPubKey, peerPubKey]
    : [peerPubKey, myPubKey]

  const concatenated = concatBytes(first, second)
  const digest = await crypto.subtle.digest('SHA-256', buf(concatenated))
  return hashToDigits(new Uint8Array(digest))
}

/**
 * Computes a group fingerprint from an arbitrary number of public keys.
 *
 * All keys are sorted lexicographically, concatenated, and hashed with
 * SHA-256.  The digest is converted to the same 60-digit decimal format
 * used by pairwise safety numbers.
 */
export async function computeGroupFingerprint(
  allPubKeys: Uint8Array[],
): Promise<string> {
  const sorted = [...allPubKeys].sort(compareBytes)
  const concatenated = concatBytes(...sorted)
  const digest = await crypto.subtle.digest('SHA-256', buf(concatenated))
  return hashToDigits(new Uint8Array(digest))
}

/**
 * Formats a 60-digit safety number string as 12 groups of 5 digits
 * separated by spaces for easy visual comparison.
 *
 * Example output:
 * "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
 */
export function formatSafetyNumber(digits: string): string {
  const groups: string[] = []
  for (let i = 0; i < digits.length; i += 5) {
    groups.push(digits.slice(i, i + 5))
  }
  return groups.join(' ')
}
