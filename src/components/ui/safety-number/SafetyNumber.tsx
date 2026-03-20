import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  computePairwiseSafetyNumber,
  computeGroupFingerprint,
  formatSafetyNumber,
} from '@/crypto'
import styles from './SafetyNumber.module.css'

interface SafetyNumberProps {
  myPubKeyRaw: Uint8Array
  peerPubKeys: Uint8Array[]
  onClose: () => void
}

export function SafetyNumber({ myPubKeyRaw, peerPubKeys, onClose }: SafetyNumberProps) {
  const [digits, setDigits] = useState<string | null>(null)

  const isGroup = peerPubKeys.length > 1

  useEffect(() => {
    let cancelled = false

    async function compute() {
      const firstPeer = peerPubKeys[0]
      if (!firstPeer) return

      const result = isGroup
        ? await computeGroupFingerprint([myPubKeyRaw, ...peerPubKeys])
        : await computePairwiseSafetyNumber(myPubKeyRaw, firstPeer)

      if (!cancelled) setDigits(result)
    }

    void compute()
    return () => { cancelled = true }
  }, [myPubKeyRaw, peerPubKeys, isGroup])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  const formatted = digits ? formatSafetyNumber(digits) : null
  const groups = formatted ? formatted.split(' ') : []

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <span className={styles.verifyLabel}>Verify</span>
        <h3 className={styles.heading}>Verify Security</h3>

        {digits === null ? (
          <p className={styles.loading}>Computing...</p>
        ) : (
          <>
            <div className={styles.grid}>
              {groups.map((group, i) => (
                <span key={i} className={styles.group}>{group}</span>
              ))}
            </div>

            <p className={styles.instruction}>
              {isGroup
                ? 'Compare this fingerprint with all participants. If it matches, the group conversation is secure.'
                : 'Compare this number with your conversation partner. If the numbers match, your conversation is secure.'}
            </p>
          </>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.doneButton} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
