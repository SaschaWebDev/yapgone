import { useState, useRef, useCallback, useEffect } from 'react';
import { IconMic, IconPause, IconPlay, IconTrash, IconViewOnce, IconEmoji } from '../icons';
import { AttachmentMenu } from '../attachment-menu';
import { EmojiFullPicker } from '../emoji-picker';
import styles from './ChatInput.module.css';

interface ChatInputProps {
  onSend: (text: string) => void;
  onSendTimed?: (text: string) => void;
  onTyping: (active: boolean) => void;
  disabled: boolean;
  maxLength: number;
  recentEmojis?: readonly string[];
  onTrackEmoji?: (emoji: string) => void;
  focusTrigger?: number;
  isRecording?: boolean;
  isSendingVoiceNote?: boolean;
  recordingDuration?: number;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onStopRecordingTimed?: () => void;
  onCancelRecording?: () => void;
  voiceNoteError?: string | null;
  voiceNoteSizeWarningSeconds?: number | null;
  isRecordingPaused?: boolean;
  onTogglePauseRecording?: () => void;
  previewAudioUrl?: string | null;
  previewDurationMs?: number;
  previewWaveform?: number[];
  onSendFile?: (file: File) => void;
  fileError?: string | null;
  onOpenPollCreator?: () => void;
  onOpenPredictionCreator?: () => void;
  onOpenPhotoComposer?: () => void;
  onOpenNotefadeComposer?: () => void;
  onCameraCapture?: (file: File) => void;
}

const TYPING_TIMEOUT = 5_000;
const MOBILE_MQ = '(max-width: 520px)';

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function downsampleWaveform(input: readonly number[], target: number): number[] {
  if (input.length === 0) return [];
  if (input.length <= target) return [...input];
  const result: number[] = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * input.length) / target);
    const end = Math.floor(((i + 1) * input.length) / target);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = input[j] ?? 0;
      if (v > max) max = v;
    }
    result.push(max);
  }
  return result;
}

export function ChatInput({
  onSend,
  onSendTimed,
  onTyping,
  disabled,
  maxLength,
  focusTrigger,
  isRecording = false,
  isSendingVoiceNote = false,
  recordingDuration = 0,
  onStartRecording,
  onStopRecording,
  onStopRecordingTimed,
  onCancelRecording,
  voiceNoteError,
  voiceNoteSizeWarningSeconds,
  isRecordingPaused = false,
  onTogglePauseRecording,
  previewAudioUrl,
  previewDurationMs = 0,
  previewWaveform,
  onSendFile,
  fileError,
  onOpenPollCreator,
  onOpenPredictionCreator,
  onOpenPhotoComposer,
  onOpenNotefadeComposer,
  onCameraCapture,
  recentEmojis,
  onTrackEmoji,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isTypingRef = useRef(false);
  const textRef = useRef('');
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Preview playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [timedMode, setTimedMode] = useState(false);

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MQ).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MQ);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const handleEmojiSelect = useCallback((emoji: string) => {
    setEmojiPickerOpen(false);
    onSend(emoji);
    onTrackEmoji?.(emoji);
  }, [onSend, onTrackEmoji]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onSendFile) return;
    onSendFile(file);
    // Reset the input so the same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [onSendFile]);

  const handleCameraCapture = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onCameraCapture) return;
    onCameraCapture(file);
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  }, [onCameraCapture]);

  const canAutoFocus = !disabled && !isRecording;

  useEffect(() => {
    if (canAutoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [canAutoFocus]);

  useEffect(() => {
    if (focusTrigger && canAutoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [focusTrigger, canAutoFocus]);

  // Auto-resize textarea to fit content (up to CSS max-height)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  // Cleanup audio on unmount or when preview URL changes
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [previewAudioUrl]);

  // Reset playback state when leaving paused state (resume or send)
  useEffect(() => {
    if (!isRecordingPaused) {
      setIsPlaying(false);
      setPlaybackMs(0);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    }
  }, [isRecordingPaused]);

  const wrapSelection = useCallback((marker: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textRef.current;
    const markerLen = marker.length;

    if (start === end) {
      // No selection: insert empty markers at cursor
      const newValue =
        value.slice(0, start) + marker + marker + value.slice(end);
      setText(newValue);
      textRef.current = newValue;
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + markerLen;
      });
      return;
    }

    const selected = value.slice(start, end);

    // Check if already wrapped (markers outside selection)
    const beforeStart = start - markerLen;
    const afterEnd = end + markerLen;
    const markersOutside =
      beforeStart >= 0 &&
      afterEnd <= value.length &&
      value.slice(beforeStart, start) === marker &&
      value.slice(end, afterEnd) === marker;

    // Check if already wrapped (markers inside selection)
    const markersInside =
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length > 2 * markerLen;

    if (markersOutside) {
      const newValue =
        value.slice(0, beforeStart) + selected + value.slice(afterEnd);
      setText(newValue);
      textRef.current = newValue;
      requestAnimationFrame(() => {
        textarea.selectionStart = beforeStart;
        textarea.selectionEnd = beforeStart + selected.length;
      });
    } else if (markersInside) {
      const unwrapped = selected.slice(markerLen, -markerLen);
      const newValue = value.slice(0, start) + unwrapped + value.slice(end);
      setText(newValue);
      textRef.current = newValue;
      requestAnimationFrame(() => {
        textarea.selectionStart = start;
        textarea.selectionEnd = start + unwrapped.length;
      });
    } else {
      const newValue =
        value.slice(0, start) + marker + selected + marker + value.slice(end);
      setText(newValue);
      textRef.current = newValue;
      requestAnimationFrame(() => {
        textarea.selectionStart = start + markerLen;
        textarea.selectionEnd = end + markerLen;
      });
    }
  }, []);

  const handleSend = useCallback((timed = false) => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (timed && onSendTimed) {
      onSendTimed(trimmed);
    } else {
      onSend(trimmed);
    }
    setText('');
    textRef.current = '';
    setTimedMode(false);
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onTyping(false);
    }
    if (isMobile) {
      textareaRef.current?.blur();
    } else {
      textareaRef.current?.focus();
    }
  }, [text, disabled, onSend, onSendTimed, onTyping, isMobile]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'b') {
        e.preventDefault();
        wrapSelection('**');
        return;
      }
      if (mod && e.key === 'i') {
        e.preventDefault();
        wrapSelection('*');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(false);
      }
    },
    [handleSend, wrapSelection],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value.slice(0, maxLength);
      setText(value);
      textRef.current = value;

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      if (value.length > 0) {
        if (!isTypingRef.current) {
          isTypingRef.current = true;
          onTyping(true);
        }
        typingTimeoutRef.current = setTimeout(() => {
          isTypingRef.current = false;
          onTyping(false);
          typingTimeoutRef.current = null;
        }, TYPING_TIMEOUT);
      } else if (isTypingRef.current) {
        isTypingRef.current = false;
        onTyping(false);
      }
    },
    [maxLength, onTyping],
  );

  const updatePlaybackPosition = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setPlaybackMs(audio.currentTime * 1000);
    if (!audio.paused) {
      animFrameRef.current = requestAnimationFrame(updatePlaybackPosition);
    }
  }, []);

  const togglePreviewPlayback = useCallback(() => {
    if (!previewAudioUrl) return;

    if (!audioRef.current) {
      const audio = new Audio(previewAudioUrl);
      audioRef.current = audio;
      audio.addEventListener('ended', () => {
        setIsPlaying(false);
        setPlaybackMs(0);
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
        }
      });
    }

    const audio = audioRef.current;
    if (isPlaying) {
      audio.pause();
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      setIsPlaying(false);
    } else {
      void audio.play();
      setIsPlaying(true);
      animFrameRef.current = requestAnimationFrame(updatePlaybackPosition);
    }
  }, [previewAudioUrl, isPlaying, updatePlaybackPosition]);

  const handleWaveformClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      if (!audio || !previewDurationMs) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );
      audio.currentTime = (fraction * previewDurationMs) / 1000;
      setPlaybackMs(fraction * previewDurationMs);
    },
    [previewDurationMs],
  );

  const showMic =
    !text.trim() &&
    !disabled &&
    !isRecording &&
    !isSendingVoiceNote &&
    !!onStartRecording;

  const sendIcon = (
    <svg
      width='30'
      height='30'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <line x1='22' y1='2' x2='11' y2='13' />
      <polygon points='22 2 15 22 11 13 2 9 22 2' />
    </svg>
  );

  // Recording mode — paused sub-state (with waveform/playback)
  if (isRecording && isRecordingPaused) {
    const fullWaveform = previewWaveform ?? [];
    const waveform = isMobile ? downsampleWaveform(fullWaveform, 14) : fullWaveform;
    const progress = previewDurationMs > 0 ? playbackMs / previewDurationMs : 0;

    return (
      <div className={styles.wrapper}>
        <div className={styles.container}>
          <button
            className={styles.cancelButton}
            onClick={onCancelRecording}
            aria-label='Discard recording'
          >
            <IconTrash size={22} />
          </button>
          <button
            className={styles.playButton}
            onClick={togglePreviewPlayback}
            aria-label={isPlaying ? 'Pause playback' : 'Play recording'}
          >
            {isPlaying ? <IconPause size={22} /> : <IconPlay size={22} />}
          </button>
          <div className={styles.previewBar}>
            <div
              className={styles.waveformContainer}
              onClick={handleWaveformClick}
              role='slider'
              aria-label='Audio preview progress'
              aria-valuemin={0}
              aria-valuemax={previewDurationMs}
              aria-valuenow={Math.round(playbackMs)}
              tabIndex={0}
            >
              {waveform.map((peak, i) => {
                const fraction = waveform.length > 0 ? i / waveform.length : 0;
                const played = fraction < progress;
                const maxPx = isMobile ? 20 : 28;
                const height = Math.max(3, peak * maxPx);
                return (
                  <div
                    key={i}
                    className={`${styles.waveformBar} ${played ? styles.waveformBarPlayed : styles.waveformBarUnplayed}`}
                    style={{ height: `${height}px` }}
                  />
                );
              })}
            </div>
            <span className={styles.previewTime}>
              {formatMs(playbackMs)} / {formatMs(previewDurationMs)}
            </span>
          </div>
          <button
            className={styles.pauseButton}
            onClick={onTogglePauseRecording}
            aria-label='Resume recording'
          >
            <IconMic size={22} />
          </button>
          <div className={styles.splitButton}>
            <button
              className={styles.splitButtonLeft}
              onClick={onStopRecording}
              aria-label='Send voice note'
            >
              {sendIcon}
            </button>
            <div className={styles.splitDivider} />
            <button
              className={styles.splitButtonRight}
              onClick={onStopRecordingTimed}
              aria-label='Send as timed voice note'
            >
              <IconViewOnce size={36} />
            </button>
          </div>
        </div>
        {voiceNoteError && (
          <span className={styles.voiceNoteError}>{voiceNoteError}</span>
        )}
      </div>
    );
  }

  // Recording mode — actively recording
  if (isRecording) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.container}>
          <button
            className={styles.cancelButton}
            onClick={onCancelRecording}
            aria-label='Cancel recording'
          >
            <IconTrash size={22} />
          </button>
          <div className={styles.recordingBar}>
            <span className={styles.recordingDot} />
            <span className={styles.recordingTimer}>
              {formatRecordingTime(recordingDuration)}
            </span>
            {voiceNoteSizeWarningSeconds !== undefined &&
              voiceNoteSizeWarningSeconds !== null && (
                <span className={styles.sizeLimitWarning}>
                  limit in {voiceNoteSizeWarningSeconds}s
                </span>
              )}
          </div>
          <button
            className={styles.pauseButton}
            onClick={onTogglePauseRecording}
            aria-label='Pause recording'
          >
            <IconPause size={22} />
          </button>
          <div className={styles.splitButton}>
            <button
              className={styles.splitButtonLeft}
              onClick={onStopRecording}
              aria-label='Send voice note'
            >
              {sendIcon}
            </button>
            <div className={styles.splitDivider} />
            <button
              className={styles.splitButtonRight}
              onClick={onStopRecordingTimed}
              aria-label='Send as timed voice note'
            >
              <IconViewOnce size={36} />
            </button>
          </div>
        </div>
        {voiceNoteError && (
          <span className={styles.voiceNoteError}>{voiceNoteError}</span>
        )}
      </div>
    );
  }

  // Normal text input mode
  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {onSendFile && (
          <>
            <input
              ref={fileInputRef}
              type='file'
              className={styles.hiddenFileInput}
              onChange={handleFileSelect}
              disabled={disabled}
              tabIndex={-1}
            />
            {onCameraCapture && (
              <input
                ref={cameraInputRef}
                type='file'
                accept='image/*'
                capture='environment'
                className={styles.hiddenFileInput}
                onChange={handleCameraCapture}
                disabled={disabled}
                tabIndex={-1}
              />
            )}
            <button
              ref={attachBtnRef}
              className={styles.attachButton}
              onClick={() => (onOpenPollCreator || onOpenPredictionCreator || onOpenPhotoComposer || onCameraCapture || onOpenNotefadeComposer) ? setAttachMenuOpen(prev => !prev) : fileInputRef.current?.click()}
              disabled={disabled}
              aria-label='Attach'
              type='button'
            >
              <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {attachMenuOpen && attachBtnRef.current && (
              <AttachmentMenu
                anchorRect={attachBtnRef.current.getBoundingClientRect()}
                onFileSelect={() => { fileInputRef.current?.click(); setAttachMenuOpen(false) }}
                onPhotoSelect={onOpenPhotoComposer ? () => { onOpenPhotoComposer(); setAttachMenuOpen(false) } : undefined}
                onCameraCapture={onCameraCapture ? () => { cameraInputRef.current?.click(); setAttachMenuOpen(false) } : undefined}
                onPollCreate={onOpenPollCreator ? () => { onOpenPollCreator(); setAttachMenuOpen(false) } : undefined}
                onPredictionCreate={onOpenPredictionCreator ? () => { onOpenPredictionCreator(); setAttachMenuOpen(false) } : undefined}
                onNotefadeCreate={onOpenNotefadeComposer ? () => { onOpenNotefadeComposer(); setAttachMenuOpen(false) } : undefined}
                onEmojiSelect={isMobile ? () => { setEmojiPickerOpen(true); setAttachMenuOpen(false) } : undefined}
                onClose={() => setAttachMenuOpen(false)}
              />
            )}
          </>
        )}
        <button
          ref={emojiBtnRef}
          className={styles.emojiButton}
          onClick={() => setEmojiPickerOpen(prev => !prev)}
          disabled={disabled}
          aria-label="Emoji"
          type="button"
        >
          <IconEmoji size={22} />
        </button>
        {emojiPickerOpen && (emojiBtnRef.current || attachBtnRef.current) && (
          <EmojiFullPicker
            onSelect={handleEmojiSelect}
            onClose={() => setEmojiPickerOpen(false)}
            recentEmojis={recentEmojis ?? []}
            anchorRect={(emojiBtnRef.current && emojiBtnRef.current.offsetWidth > 0 ? emojiBtnRef.current : attachBtnRef.current!).getBoundingClientRect()}
          />
        )}
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={`${styles.input}${isMobile && !showMic && onSendTimed ? ` ${styles.inputHasTimedToggle}` : ''}`}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder='Type a message'
            disabled={disabled}
            rows={1}
            maxLength={maxLength}
            aria-label='Message input'
          />
          {isMobile && !showMic && onSendTimed && (
            <button
              type='button'
              className={`${styles.timedToggle}${timedMode ? ` ${styles.timedToggleActive}` : ''}`}
              onClick={() => setTimedMode(prev => !prev)}
              aria-label={timedMode ? 'Disable timed message' : 'Enable timed message'}
            >
              <IconViewOnce size={20} />
            </button>
          )}
        </div>
        {showMic ? (
          <button
            className={styles.micButton}
            onClick={onStartRecording}
            aria-label='Record voice note'
          >
            <IconMic size={30} />
          </button>
        ) : isMobile ? (
          <button
            className={styles.mobileSendButton}
            onClick={() => handleSend(timedMode)}
            disabled={disabled || !text.trim()}
            aria-label={timedMode ? 'Send as timed message' : 'Send message'}
          >
            <svg width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
              <line x1='22' y1='2' x2='11' y2='13' />
              <polygon points='22 2 15 22 11 13 2 9 22 2' />
            </svg>
          </button>
        ) : (
          <div className={styles.splitButton}>
            <button
              className={styles.splitButtonLeft}
              onClick={() => handleSend(false)}
              disabled={disabled || !text.trim()}
              aria-label='Send message'
            >
              {sendIcon}
            </button>
            <div className={styles.splitDivider} />
            <button
              className={styles.splitButtonRight}
              onClick={() => handleSend(true)}
              disabled={disabled || !text.trim()}
              aria-label='Send as timed message'
            >
              <IconViewOnce size={36} />
            </button>
          </div>
        )}
      </div>
      {voiceNoteError && (
        <span className={styles.voiceNoteError}>{voiceNoteError}</span>
      )}
      {fileError && (
        <span className={styles.voiceNoteError}>{fileError}</span>
      )}
      {maxLength - text.length <= 0 && (
        <span className={styles.charLimitMax}>Character limit reached</span>
      )}
    </div>
  );
}
