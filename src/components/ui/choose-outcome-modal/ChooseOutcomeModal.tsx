import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { PredictionOption } from '@/hooks/chat-helpers'
import styles from './ChooseOutcomeModal.module.css'

interface ChooseOutcomeModalProps {
  predictionTitle: string
  options: PredictionOption[]
  onChoose: (index: number) => void
  onClose: () => void
}

export function ChooseOutcomeModal({ predictionTitle, options, onChoose, onClose }: ChooseOutcomeModalProps) {
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmIndex !== null) {
          setConfirmIndex(null)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, confirmIndex])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const handleConfirm = useCallback(() => {
    if (confirmIndex === null) return
    onChoose(confirmIndex)
    onClose()
  }, [confirmIndex, onChoose, onClose])

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.heading}>Choose Outcome</h3>
        <p className={styles.description}>
          Select the result for the others who voted for it.
        </p>
        <p className={styles.predictionTitle}>{predictionTitle}</p>

        {confirmIndex !== null ? (
          <div className={styles.confirmBlock}>
            <p className={styles.confirmText}>
              Are you sure &ldquo;{options[confirmIndex]?.text}&rdquo; is the outcome?
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={() => setConfirmIndex(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={handleConfirm}
              >
                Confirm
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.optionsList}>
            {options.map((opt, i) => (
              <button
                key={i}
                type="button"
                className={styles.optionButton}
                onClick={() => setConfirmIndex(i)}
              >
                <span className={styles.optionText}>{opt.text}</span>
                <span className={styles.optionVotes}>
                  {opt.votes} {opt.votes === 1 ? 'vote' : 'votes'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
