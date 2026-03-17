import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { EmojiFullPicker } from '../emoji-picker'
import { IconViewOnce, IconEmoji } from '../icons'
import { GALLERY_MAX_IMAGES, GALLERY_IMAGE_ACCEPT, FILE_MAX_IMAGE_BYTES, IMAGE_MIME_TYPES, MAX_MESSAGE_LENGTH } from '@/constants'
import styles from './PhotoComposer.module.css'

interface PhotoEntry {
  file: File
  previewUrl: string
}

interface PhotoComposerProps {
  onSend: (files: File[], caption?: string, timed?: boolean) => void
  onClose: () => void
  recentEmojis?: readonly string[]
  onTrackEmoji?: (emoji: string) => void
}

export function PhotoComposer({ onSend, onClose, recentEmojis = [], onTrackEmoji }: PhotoComposerProps) {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [swapSource, setSwapSource] = useState<number | null>(null)
  const [caption, setCaption] = useState('')
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const captionRef = useRef<HTMLInputElement>(null)
  const emojiBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Open file picker on mount
    fileInputRef.current?.click()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (emojiPickerOpen) {
          setEmojiPickerOpen(false)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, emojiPickerOpen])

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      photos.forEach(p => URL.revokeObjectURL(p.previewUrl))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files)
    const valid = fileArray.filter(f =>
      f.size > 0 &&
      f.size <= FILE_MAX_IMAGE_BYTES &&
      IMAGE_MIME_TYPES.has(f.type) &&
      f.type !== 'image/svg+xml'
    )

    setPhotos(prev => {
      const remaining = GALLERY_MAX_IMAGES - prev.length
      const toAdd = valid.slice(0, remaining)
      return [
        ...prev,
        ...toAdd.map(file => ({
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]
    })
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) {
      // User cancelled file picker with no photos selected — close modal
      if (photos.length === 0) {
        onClose()
        return
      }
      return
    }
    addFiles(files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [addFiles, onClose, photos.length])

  const removePhoto = useCallback((index: number) => {
    setPhotos(prev => {
      const removed = prev[index]
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      const next = prev.filter((_, i) => i !== index)
      return next
    })
    setSelectedIndex(prev => {
      if (prev >= photos.length - 1) return Math.max(0, photos.length - 2)
      return prev
    })
    setSwapSource(null)
  }, [photos.length])

  const handleThumbnailClick = useCallback((index: number) => {
    if (swapSource === null) {
      setSwapSource(index)
    } else if (swapSource === index) {
      setSwapSource(null)
    } else {
      // Swap
      setPhotos(prev => {
        const next = [...prev]
        const temp = next[swapSource]
        const target = next[index]
        if (temp && target) {
          next[swapSource] = target
          next[index] = temp
        }
        return next
      })
      setSelectedIndex(index)
      setSwapSource(null)
    }
  }, [swapSource])

  const handlePreviewClick = useCallback((index: number) => {
    setSelectedIndex(index)
    setSwapSource(null)
  }, [])

  const handleSend = useCallback((timed = false) => {
    if (photos.length === 0) return
    const files = photos.map(p => p.file)
    const trimmed = caption.trim()
    onSend(files, trimmed || undefined, timed || undefined)
    onClose()
  }, [photos, caption, onSend, onClose])

  const handleEmojiSelect = useCallback((emoji: string) => {
    setCaption(prev => (prev + emoji).slice(0, MAX_MESSAGE_LENGTH))
    onTrackEmoji?.(emoji)
    setEmojiPickerOpen(false)
  }, [onTrackEmoji])

  const openEmojiPicker = useCallback(() => {
    const el = emojiBtnRef.current
    if (el) {
      setAnchorRect(el.getBoundingClientRect())
      setEmojiPickerOpen(true)
    }
  }, [])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const selectedPhoto = photos[selectedIndex]

  const sendIcon = (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )

  return createPortal(
    <>
    <div className={styles.overlay} onClick={handleBackdropClick}>
      <input
        ref={fileInputRef}
        type="file"
        accept={GALLERY_IMAGE_ACCEPT}
        multiple
        className={styles.hiddenInput}
        onChange={handleFileChange}
        tabIndex={-1}
      />
      <div className={styles.modal}>
        <h3 className={styles.heading}>Photo Gallery</h3>

        {photos.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyText}>Select up to {GALLERY_MAX_IMAGES} photos</p>
            <button
              type="button"
              className={styles.pickButton}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose Photos
            </button>
          </div>
        ) : (
          <>
            {/* Main preview */}
            <div className={styles.preview}>
              {selectedPhoto && (
                <img
                  className={styles.previewImage}
                  src={selectedPhoto.previewUrl}
                  alt={selectedPhoto.file.name}
                />
              )}
            </div>

            {/* Thumbnail strip */}
            <div className={styles.thumbnailStrip}>
              {photos.map((photo, i) => (
                <div
                  key={photo.previewUrl}
                  className={`${styles.thumbnail}${i === selectedIndex ? ` ${styles.thumbnailSelected}` : ''}${swapSource === i ? ` ${styles.thumbnailSwapSource}` : ''}`}
                  onClick={() => handlePreviewClick(i)}
                >
                  <img
                    className={styles.thumbnailImage}
                    src={photo.previewUrl}
                    alt={photo.file.name}
                  />
                  <button
                    type="button"
                    className={styles.thumbnailRemove}
                    onClick={(e) => { e.stopPropagation(); removePhoto(i) }}
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    &times;
                  </button>
                  <button
                    type="button"
                    className={`${styles.thumbnailReorder}${swapSource === i ? ` ${styles.thumbnailReorderActive}` : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleThumbnailClick(i) }}
                    aria-label={swapSource === i ? 'Cancel reorder' : `Reorder photo ${i + 1}`}
                  >
                    {swapSource === i ? '\u2716' : '\u2B82'}
                  </button>
                </div>
              ))}
              {photos.length < GALLERY_MAX_IMAGES && (
                <button
                  type="button"
                  className={styles.addButton}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Add more photos"
                >
                  +
                </button>
              )}
            </div>

            {/* Caption input */}
            <div className={styles.captionRow}>
              <input
                ref={captionRef}
                type="text"
                className={styles.captionInput}
                value={caption}
                onChange={(e) => setCaption(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
                placeholder="Add a caption..."
              />
              <button
                ref={emojiBtnRef}
                type="button"
                className={styles.captionEmojiButton}
                onClick={openEmojiPicker}
                aria-label="Insert emoji"
              >
                <IconEmoji size={16} />
              </button>
            </div>

            {/* Footer */}
            <div className={styles.footer}>
              <button type="button" className={styles.cancelButton} onClick={onClose}>
                Cancel
              </button>
              <div className={styles.splitButton}>
                <button
                  type="button"
                  className={styles.splitButtonLeft}
                  disabled={photos.length === 0}
                  onClick={() => handleSend(false)}
                  aria-label="Send gallery"
                >
                  {sendIcon}
                </button>
                <div className={styles.splitDivider} />
                <button
                  type="button"
                  className={styles.splitButtonRight}
                  disabled={photos.length === 0}
                  onClick={() => handleSend(true)}
                  aria-label="Send as timed gallery"
                >
                  <IconViewOnce size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    {emojiPickerOpen && anchorRect && (
      <EmojiFullPicker
        onSelect={handleEmojiSelect}
        onClose={() => setEmojiPickerOpen(false)}
        recentEmojis={recentEmojis}
        anchorRect={anchorRect}
        alignRight
      />
    )}
    </>,
    document.body,
  )
}
