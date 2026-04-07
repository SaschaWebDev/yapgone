import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  PREDICTION_MAX_OPTIONS,
  PREDICTION_MAX_TITLE_LENGTH,
  PREDICTION_MAX_OPTION_LENGTH,
  PREDICTION_DURATION_OPTIONS,
} from '@/constants';
import type { PredictionMode } from '@/hooks/chat-helpers';
import styles from './PredictionCreator.module.css';

const DURATION_LABELS: Record<number, string> = {
  30_000: '30 seconds',
  60_000: '1 minute',
  120_000: '2 minutes',
  300_000: '5 minutes',
  600_000: '10 minutes',
  900_000: '15 minutes',
  1_200_000: '20 minutes',
  1_800_000: '30 minutes',
};

interface PredictionCreatorProps {
  onSend: (
    title: string,
    options: string[],
    durationMs: number,
    mode: PredictionMode,
  ) => void;
  onClose: () => void;
}

export function PredictionCreator({ onSend, onClose }: PredictionCreatorProps) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<PredictionMode>('yesno');
  const [options, setOptions] = useState(['', '']);
  const [durationMs, setDurationMs] = useState(120_000);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const updateOption = useCallback((index: number, text: string) => {
    setOptions((prev) => {
      const next = [...prev];
      next[index] = text;
      let lastNonEmpty = -1;
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.trim().length > 0) {
          lastNonEmpty = i;
          break;
        }
      }
      if (
        lastNonEmpty === next.length - 1 &&
        next.length < PREDICTION_MAX_OPTIONS
      ) {
        next.push('');
      }
      return next;
    });
  }, []);

  const removeOption = useCallback((index: number) => {
    setOptions((prev) =>
      prev.length > 2 ? prev.filter((_, i) => i !== index) : prev,
    );
  }, []);

  const nonEmptyOptions = options.filter((o) => o.trim().length > 0);
  const canSend =
    mode === 'yesno'
      ? title.trim().length > 0
      : title.trim().length > 0 && nonEmptyOptions.length >= 2;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const finalOptions = mode === 'yesno' ? ['Yes', 'No'] : nonEmptyOptions;
    onSend(title.trim(), finalOptions, durationMs, mode);
    onClose();
  }, [canSend, mode, title, nonEmptyOptions, durationMs, onSend, onClose]);

  const placeholders = ["outcome 1, like 'yes'", "outcome 2, like 'no'"];

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.heading}>Start a prediction</h3>

        <label className={styles.sectionLabel}>Name the prediction</label>
        <input
          ref={titleRef}
          type='text'
          className={styles.input}
          value={title}
          onChange={(e) =>
            setTitle(e.target.value.slice(0, PREDICTION_MAX_TITLE_LENGTH))
          }
          placeholder="What will others predict? 'Will I win the current game?'"
        />

        <div className={styles.divider} />

        <h4 className={styles.sectionHeading}>Prediction type</h4>
        <div className={styles.modeSelector}>
          <button
            type='button'
            className={`${styles.modeButton}${mode === 'yesno' ? ` ${styles.modeButtonActive}` : ''}`}
            onClick={() => setMode('yesno')}
          >
            Yes / No
          </button>
          <button
            type='button'
            className={`${styles.modeButton}${mode === 'complex' ? ` ${styles.modeButtonActive}` : ''}`}
            onClick={() => setMode('complex')}
          >
            Custom outcomes
          </button>
        </div>

        {mode === 'yesno' ? (
          <p className={styles.sectionDescription}>
            Participants vote Yes or No. A badge will show their pick until the
            prediction ends.
          </p>
        ) : (
          <>
            <h4 className={styles.sectionHeading}>Possible outcomes</h4>
            <p className={styles.sectionDescription}>
              Others will receive a temporary chat badge indicating the option
              they voted for until the prediction ends.
            </p>

            <div className={styles.optionsList}>
              {options.map((opt, i) => (
                <div key={i} className={styles.optionRow}>
                  <span className={styles.optionNumber}>{i + 1}</span>
                  <input
                    type='text'
                    className={styles.optionInput}
                    value={opt}
                    onChange={(e) =>
                      updateOption(
                        i,
                        e.target.value.slice(0, PREDICTION_MAX_OPTION_LENGTH),
                      )
                    }
                    placeholder={placeholders[i] ?? `Outcome ${i + 1}`}
                  />
                  {options.length > 2 && (
                    <button
                      type='button'
                      tabIndex={-1}
                      className={styles.removeButton}
                      onClick={() => removeOption(i)}
                      aria-label={`Remove outcome ${i + 1}`}
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className={styles.divider} />

        <h4 className={styles.sectionHeading}>Submission</h4>
        <select
          className={styles.select}
          value={durationMs}
          onChange={(e) => setDurationMs(Number(e.target.value))}
        >
          {PREDICTION_DURATION_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>
              {DURATION_LABELS[ms] ?? `${ms / 1000}s`}
            </option>
          ))}
        </select>
        <p className={styles.sectionDescription}>
          How long others have to guess the outcome.
        </p>

        <div className={styles.footer}>
          <button
            type='button'
            className={styles.cancelButton}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type='button'
            className={styles.sendButton}
            disabled={!canSend}
            onClick={handleSend}
          >
            Start Prediction
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
