import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { SenderIdentity } from '@/utils/sender-identity'
import { PatternedCircle } from '../patterned-circle'
import { IconPhone, IconCamera } from '../icons'
import styles from './ParticipantList.module.css'

interface Participant {
  clientId: string
  username: string | null
  isYou: boolean
}

interface ParticipantListProps {
  participants: Participant[]
  identityMap: ReadonlyMap<string, SenderIdentity>
  onClose: () => void
  onCallParticipant?: (clientId: string) => void
  onVideoCallParticipant?: (clientId: string) => void
  canCall?: boolean
}

export function ParticipantList({ participants, identityMap, onClose, onCallParticipant, onVideoCallParticipant, canCall }: ParticipantListProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.heading}>
            Participants
            <span className={styles.count}>{participants.length}</span>
          </h3>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <ul className={styles.list}>
          {participants.map((p) => {
            const identity = identityMap.get(p.clientId)
            return (
            <li key={p.clientId} className={styles.row}>
              <PatternedCircle
                color={identity?.color ?? '#78909C'}
                patternCss={identity?.patternCss ?? 'none'}
                patternSize={identity?.patternSize ?? '0'}
              />
              <span className={styles.name}>
                {p.username ?? 'Anonymous'}
              </span>
              {p.isYou && <span className={styles.badge}>(you)</span>}
              {!p.isYou && canCall && (
                <div className={styles.callActions}>
                  {onVideoCallParticipant && (
                    <button
                      type="button"
                      className={styles.videoCallButton}
                      onClick={(e) => { e.stopPropagation(); onVideoCallParticipant(p.clientId) }}
                      title={`Video call ${p.username ?? 'Anonymous'}`}
                      aria-label={`Video call ${p.username ?? 'Anonymous'}`}
                    >
                      <IconCamera size={14} />
                    </button>
                  )}
                  {onCallParticipant && (
                    <button
                      type="button"
                      className={styles.callButton}
                      onClick={(e) => { e.stopPropagation(); onCallParticipant(p.clientId) }}
                      title={`Call ${p.username ?? 'Anonymous'}`}
                      aria-label={`Call ${p.username ?? 'Anonymous'}`}
                    >
                      <IconPhone size={14} />
                    </button>
                  )}
                </div>
              )}
            </li>
            )
          })}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
