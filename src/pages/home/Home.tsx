import { useState, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, toBase64Url, xorSplit } from '@/crypto'
import { createRoom, storeShard, buildSplitInviteFragment } from '@/api'
import { STORAGE_KEYS } from '@/constants'
import { DEFAULT_ROOM_SETTINGS } from '@/room-settings'
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
      const roomId = await createRoom(DEFAULT_ROOM_SETTINGS.maxParticipants)
      const pubKeyRaw = await exportPublicKey(kp.publicKey)

      // XOR-split the pubkey: URL share + server shard
      const { share1: urlShare, share2: serverShard } = xorSplit(pubKeyRaw)
      const urlShareB64 = toBase64Url(urlShare)
      const serverShardB64 = toBase64Url(serverShard)

      // Store server shard (auto-expires via KV TTL)
      await storeShard(roomId, serverShardB64)

      const fragment = buildSplitInviteFragment(roomId, urlShareB64)

      localStorage.setItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`, '1')
      window.location.hash = fragment
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room')
      setLoading(false)
    }
  }, [loading])

  return (
    <div className={styles.wrapper}>
      <img src="/yapgone-logo.png" alt="" className={styles.heroLogo} />
      <h1 className={styles.heading}>Encrypted yapping, gone for good</h1>
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
