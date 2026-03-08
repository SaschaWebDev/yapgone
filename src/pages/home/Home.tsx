import { useState, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, toBase64Url } from '@/crypto'
import { createRoom, buildInviteFragment } from '@/api'
import { STORAGE_KEYS } from '@/constants'
import styles from './Home.module.css'

export function Home() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError(null)

    try {
      const kp = await generateKeyPair()
      const roomId = await createRoom()
      const pubKeyRaw = await exportPublicKey(kp.publicKey)
      const pubKeyB64 = toBase64Url(pubKeyRaw)
      const fragment = buildInviteFragment(roomId, pubKeyB64)

      sessionStorage.setItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`, '1')
      window.location.hash = fragment
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
      setLoading(false)
    }
  }, [loading])

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.heading}>Encrypted chat that fades away</h1>
      <p className={styles.description}>
        End-to-end encrypted. No accounts. No history.
        When the conversation ends, everything disappears.
      </p>
      <button
        className={styles.createButton}
        onClick={handleCreate}
        disabled={loading}
      >
        {loading ? 'Creating...' : 'Start a conversation'}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
