import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { senderColor } from '@/hooks/chat-helpers'
import { IconPhone } from '../icons'
import styles from './ParticipantList.module.css'

interface Participant {
  clientId: string
  username: string | null
  isYou: boolean
}

interface ParticipantListProps {
  participants: Participant[]
  onClose: () => void
  onCallParticipant?: (clientId: string) => void
  canCall?: boolean
}

export function ParticipantList({ participants, onClose, onCallParticipant, canCall }: ParticipantListProps) {
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
          {participants.map((p) => (
            <li key={p.clientId} className={styles.row}>
              <span
                className={styles.circle}
                style={{ backgroundColor: senderColor(p.clientId) }}
              />
              <span className={styles.name}>
                {p.username ?? 'Anonymous'}
              </span>
              {p.isYou && <span className={styles.badge}>(you)</span>}
              {!p.isYou && canCall && onCallParticipant && (
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
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
