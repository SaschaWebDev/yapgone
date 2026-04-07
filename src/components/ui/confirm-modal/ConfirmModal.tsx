import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../button';
import styles from './ConfirmModal.module.css';
import type { ReactNode } from 'react';

interface ConfirmModalProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirmIntent?: 'positive' | 'destructive';
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmModal({
  title,
  description,
  children,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmIntent = 'positive',
  onConfirm,
  onClose,
}: ConfirmModalProps) {
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

  return createPortal(
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <h3 className={styles.title}>{title}</h3>
        {description && <div className={styles.description}>{description}</div>}
        {children}
        <div className={styles.footer}>
          <Button intent="neutral" size="sm" onClick={onClose}>
            {cancelText}
          </Button>
          <Button intent={confirmIntent} size="sm" onClick={onConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
