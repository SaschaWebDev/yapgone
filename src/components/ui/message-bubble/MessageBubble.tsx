import { useState, useRef, useCallback, useEffect } from 'react';
import { formatMessage } from '@/utils/format-message';
import { isEmojiOnly } from '@/utils';
import { EmojiQuickPick, EmojiFullPicker } from '../emoji-picker';
import { ReactionDetail } from '../reaction-detail';
import { IconNotefade } from '../icons';
import type {
  MessageReaction,
  PollOption,
  GalleryImage,
} from '@/hooks/use-chat';
import type {
  PredictionOption,
  PredictionState,
  PredictionMode,
} from '@/hooks/chat-helpers';
import {
  TIMED_MESSAGE_TTL_MS,
  TIMED_MESSAGE_FADEOUT_MS,
  TIMED_VOICE_FALLBACK_TTL_MS,
  PREDICTION_TIMER_INTERVAL_MS,
} from '@/constants';
import { ChooseOutcomeModal } from '../choose-outcome-modal';
import { ConfirmModal } from '../confirm-modal';
import styles from './MessageBubble.module.css';

type PickerMode = 'closed' | 'compact' | 'expanded';

interface MessageBubbleProps {
  kind?:
    | 'text'
    | 'audio'
    | 'image'
    | 'video'
    | 'file'
    | 'poll'
    | 'prediction'
    | 'gallery'
    | 'notefade'
    | 'notefade-chat';
  text?: string;
  audioUrl?: string;
  durationMs?: number;
  fileUrl?: string;
  fileName?: string;
  fileMimeType?: string;
  fileSize?: number;
  transferProgress?: number;
  sender: 'self' | 'peer' | 'system';
  displayName?: string;
  timestamp: number;
  reactions?: MessageReaction[];
  replyTo?: string;
  replyPreview?: string;
  msgId?: string;
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onReplyClick?: () => void;
  onCopy?: () => void;
  onDownload?: () => void;
  skipAnimation?: boolean;
  recentEmojis?: readonly string[];
  timed?: boolean;
  onTimedExpire?: (msgId: string) => void;
  onPlayOnceComplete?: (msgId: string) => void;
  timedConsumed?: boolean;
  autoPlay?: boolean;
  onAudioEnded?: (msgId: string) => void;
  waveform?: readonly number[];
  onImageClick?: () => void;
  pollQuestion?: string;
  pollEmoji?: string;
  pollOptions?: PollOption[];
  pollAllowMultiple?: boolean;
  pollMyVotes?: number[];
  pollId?: string;
  onPollVote?: (pollId: string, optionIndices: number[]) => void;
  predictionId?: string;
  predictionTitle?: string;
  predictionOptions?: PredictionOption[];
  predictionMyVote?: number;
  predictionDurationMs?: number;
  predictionCreatedAt?: number;
  predictionState?: PredictionState;
  predictionWinnerIndex?: number;
  predictionMode?: PredictionMode;
  isModerator?: boolean;
  onPredictionVote?: (predictionId: string, optionIndex: number) => void;
  onPredictionChooseOutcome?: (
    predictionId: string,
    winnerIndex: number,
  ) => void;
  onPredictionDelete?: (predictionId: string) => void;
  predictionBadge?: { text: string; color: string };
  notefadeUrl?: string;
  notefadeRevealedText?: string;
  notefadeRevealed?: boolean;
  notefadeDestroyed?: boolean;
  onRevealNotefade?: (messageId: string, url: string) => void;
  onDestroyNotefade?: (messageId: string, url: string) => void;
  gallery?: GalleryImage[];
  onGalleryImageClick?: (index: number) => void;
  senderColor?: string;
  resolveReactorName?: (reaction: MessageReaction) => string;
  onImageLoad?: () => void;
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SPEEDS = [1, 1.5, 2] as const;

function AudioPlayer({
  src,
  durationMs,
  waveform,
  isSelf,
  timestamp,
  timed,
  onPlayOnceComplete,
  autoPlay,
  onAudioEnded,
}: {
  src: string;
  durationMs?: number;
  waveform?: readonly number[];
  isSelf: boolean;
  timestamp: number;
  timed?: boolean;
  onPlayOnceComplete?: () => void;
  autoPlay?: boolean;
  onAudioEnded?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [hasPlayed, setHasPlayed] = useState(false);
  const hasPlayedRef = useRef(false);
  const autoPlayedRef = useRef(false);

  const isPlayOnce = timed && !isSelf;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      const knownDuration = durationMs ? durationMs / 1000 : 0;
      const effectiveDuration =
        knownDuration > 0
          ? knownDuration
          : audio.duration && isFinite(audio.duration)
            ? audio.duration
            : 0;
      if (effectiveDuration > 0) {
        setProgress(Math.min(1, audio.currentTime / effectiveDuration));
        setCurrentTime(audio.currentTime);
      }
    };

    const onLoadedMetadata = () => {
      if (!durationMs && audio.duration && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const onEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
      onPlayOnceComplete?.();
      onAudioEnded?.();
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [durationMs, onPlayOnceComplete, onAudioEnded]);

  useEffect(() => {
    if (durationMs) setDuration(durationMs / 1000);
  }, [durationMs]);

  useEffect(() => {
    if (autoPlay && !autoPlayedRef.current) {
      autoPlayedRef.current = true;
      const audio = audioRef.current;
      if (!audio) return;
      if (isPlayOnce) {
        if (hasPlayedRef.current) return;
        hasPlayedRef.current = true;
        setHasPlayed(true);
      }
      audio.play().catch(() => setIsPlaying(false));
      setIsPlaying(true);
    }
    if (!autoPlay) {
      autoPlayedRef.current = false;
    }
  }, [autoPlay, isPlayOnce]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlayOnce) {
      if (hasPlayedRef.current) return;
      hasPlayedRef.current = true;
      setHasPlayed(true);
      audio.play().catch(() => setIsPlaying(false));
      setIsPlaying(true);
      return;
    }

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => setIsPlaying(false));
      setIsPlaying(true);
    }
  }, [isPlaying, isPlayOnce]);

  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isPlayOnce) return;
      const audio = audioRef.current;
      const track = trackRef.current;
      if (!audio || !track) return;
      const knownDuration = durationMs ? durationMs / 1000 : 0;
      const effectiveDuration =
        knownDuration > 0
          ? knownDuration
          : audio.duration && isFinite(audio.duration)
            ? audio.duration
            : 0;
      if (effectiveDuration <= 0) return;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      audio.currentTime = ratio * effectiveDuration;
      setProgress(ratio);
      setCurrentTime(audio.currentTime);
    },
    [isPlayOnce, durationMs],
  );

  const cycleSpeed = useCallback(() => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    const rate = SPEEDS[next] ?? 1;
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, [speedIndex]);

  const timeLabel =
    isPlaying && duration > 0
      ? formatSeconds(duration - currentTime)
      : formatSeconds(duration);

  const formattedTime = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const hidePlayButton = isPlayOnce && (isPlaying || hasPlayed);

  return (
    <div className={styles.audioPlayer}>
      <div className={styles.audioControls}>
        <audio ref={audioRef} src={src} preload='metadata' />
        <button
          className={`${styles.playButton} ${isSelf ? styles.playButtonSelf : styles.playButtonPeer}${hidePlayButton ? ` ${styles.playButtonHidden}` : ''}`}
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          disabled={hidePlayButton}
          aria-hidden={hidePlayButton || undefined}
        >
          {isPlaying ? (
            <svg width='21' height='21' viewBox='0 0 24 24' fill='currentColor'>
              <rect x='6' y='4' width='4' height='16' rx='1' />
              <rect x='14' y='4' width='4' height='16' rx='1' />
            </svg>
          ) : (
            <svg width='21' height='21' viewBox='0 0 24 24' fill='currentColor'>
              <polygon points='7 3 21 12 7 21' />
            </svg>
          )}
        </button>
        <div
          ref={trackRef}
          className={`${styles.waveformTrack}${isPlayOnce ? ` ${styles.waveformTrackNoSeek}` : ''}`}
          onClick={handleSeek}
          role='progressbar'
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {waveform && waveform.length > 0 ? (
            waveform.map((peak, i) => (
              <div
                key={i}
                className={`${styles.waveformBar} ${
                  i / waveform.length < progress
                    ? isSelf
                      ? styles.waveformBarPlayedSelf
                      : styles.waveformBarPlayedPeer
                    : isSelf
                      ? styles.waveformBarUnplayedSelf
                      : styles.waveformBarUnplayedPeer
                }`}
                style={{ height: `${Math.max(3, peak * 28)}px` }}
              />
            ))
          ) : (
            <div
              className={`${styles.progressTrackInner} ${isSelf ? styles.progressTrackSelf : styles.progressTrackPeer}`}
            >
              <div
                className={`${styles.progressFill} ${isSelf ? styles.progressFillSelf : styles.progressFillPeer}`}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}
        </div>
        <span className={styles.audioDuration}>{timeLabel}</span>
      </div>
      <div className={styles.audioMeta}>
        {isPlayOnce ? (
          <span className={styles.timedAudioBadge}>
            <svg
              width='10'
              height='10'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='12' cy='12' r='10' />
              <polyline points='12 6 12 12 16 14' />
            </svg>
            timed
          </span>
        ) : timed ? (
          <span className={styles.timedAudioBadge}>
            <svg
              width='10'
              height='10'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='12' cy='12' r='10' />
              <polyline points='12 6 12 12 16 14' />
            </svg>
            timed
          </span>
        ) : (
          <button
            className={`${styles.speedBadge} ${isSelf ? styles.speedBadgeSelf : styles.speedBadgePeer} ${speedIndex > 0 ? styles.speedActive : ''}`}
            onClick={cycleSpeed}
            aria-label={`Playback speed ${SPEEDS[speedIndex]}×`}
          >
            {SPEEDS[speedIndex]}×
          </button>
        )}
        <div className={styles.audioMetaRight}>
          <time
            className={styles.time}
            dateTime={new Date(timestamp).toISOString()}
          >
            {formattedTime}
          </time>
        </div>
      </div>
    </div>
  );
}

interface GroupedReaction {
  emoji: string;
  count: number;
  hasSelf: boolean;
}

function groupReactions(reactions: MessageReaction[]): GroupedReaction[] {
  const map = new Map<string, { count: number; hasSelf: boolean }>();
  for (const r of reactions) {
    const existing = map.get(r.emoji);
    if (existing) {
      existing.count++;
      if (r.fromSelf) existing.hasSelf = true;
    } else {
      map.set(r.emoji, { count: 1, hasSelf: r.fromSelf });
    }
  }
  return Array.from(map.entries()).map(([emoji, { count, hasSelf }]) => ({
    emoji,
    count,
    hasSelf,
  }));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PollBubbleContent({
  pollId,
  pollEmoji,
  pollQuestion,
  pollOptions,
  pollAllowMultiple,
  pollMyVotes,
  onPollVote,
  isSelf,
  timestamp,
}: {
  pollId: string;
  pollEmoji?: string;
  pollQuestion?: string;
  pollOptions: PollOption[];
  pollAllowMultiple?: boolean;
  pollMyVotes?: number[];
  onPollVote?: (pollId: string, optionIndices: number[]) => void;
  isSelf: boolean;
  timestamp: number;
}) {
  const totalVotes = pollOptions.reduce((sum, o) => sum + o.votes, 0);
  const myVotes = pollMyVotes ?? [];

  const handleOptionClick = useCallback(
    (index: number) => {
      if (!onPollVote) return;
      if (pollAllowMultiple) {
        const next = myVotes.includes(index)
          ? myVotes.filter((i) => i !== index)
          : [...myVotes, index];
        onPollVote(pollId, next);
      } else {
        const next = myVotes.includes(index) ? [] : [index];
        onPollVote(pollId, next);
      }
    },
    [onPollVote, pollId, pollAllowMultiple, myVotes],
  );

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={styles.pollContent}>
      <div className={styles.pollHeader}>
        {pollEmoji && <span className={styles.pollEmoji}>{pollEmoji}</span>}
        <span className={styles.pollQuestion}>{pollQuestion}</span>
      </div>
      <span className={styles.pollMode}>
        {pollAllowMultiple ? 'Multiple answers' : 'Single answer'}
      </span>
      <div className={styles.pollOptions}>
        {pollOptions.map((opt, i) => {
          const selected = myVotes.includes(i);
          const pct = totalVotes > 0 ? (opt.votes / totalVotes) * 100 : 0;
          return (
            <button
              key={i}
              type='button'
              className={`${styles.pollOption}${selected ? ` ${styles.pollOptionSelected}` : ''}`}
              onClick={() => handleOptionClick(i)}
              disabled={!onPollVote}
            >
              <div
                className={`${styles.pollProgressBar} ${isSelf ? styles.pollProgressBarSelf : styles.pollProgressBarPeer}`}
                style={{ width: `${pct}%` }}
              />
              <span className={styles.pollIndicator}>
                {pollAllowMultiple
                  ? selected
                    ? '\u2611'
                    : '\u2610'
                  : selected
                    ? '\u25CF'
                    : '\u25CB'}
              </span>
              {opt.emoji && <span>{opt.emoji}</span>}
              <span className={styles.pollOptionText}>{opt.text}</span>
              <span className={styles.pollVoteCount}>{opt.votes}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.pollFooter}>
        <span>
          {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
        </span>
        <time
          className={styles.time}
          dateTime={new Date(timestamp).toISOString()}
        >
          {time}
        </time>
      </div>
    </div>
  );
}

function GalleryBubbleContent({
  gallery,
  caption,
  isSelf,
  timestamp,
  timed,
  onImageClick,
  onImageLoad,
}: {
  gallery: GalleryImage[];
  caption?: string;
  isSelf: boolean;
  timestamp: number;
  timed?: boolean;
  onImageClick?: (index: number) => void;
  onImageLoad?: () => void;
}) {
  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const count = gallery.length;
  const layoutClass =
    count === 1
      ? styles.galleryGrid1
      : count === 2
        ? styles.galleryGrid2
        : count === 3
          ? styles.galleryGrid3
          : count === 4
            ? styles.galleryGrid4
            : styles.galleryGrid5;

  return (
    <div className={styles.galleryContent}>
      {timed && (
        <span className={styles.timedBadge}>
          <svg
            width='12'
            height='12'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <circle cx='12' cy='12' r='10' />
            <polyline points='12 6 12 12 16 14' />
          </svg>
          timed
        </span>
      )}
      <div className={`${styles.galleryGrid} ${layoutClass}`}>
        {gallery.map((img, i) => (
          <div key={img.fileId} className={styles.galleryTile}>
            {img.transferProgress !== undefined ? (
              <div className={styles.galleryTileProgress}>
                <div className={styles.transferProgressBar}>
                  <div
                    className={`${styles.transferProgressFill} ${isSelf ? styles.transferProgressFillSelf : styles.transferProgressFillPeer}`}
                    style={{
                      width: `${Math.round(img.transferProgress * 100)}%`,
                    }}
                  />
                </div>
                <span className={styles.transferText}>
                  {Math.round(img.transferProgress * 100)}%
                </span>
              </div>
            ) : img.fileUrl ? (
              <img
                className={styles.galleryTileImage}
                src={img.fileUrl}
                alt={img.fileName}
                loading='lazy'
                onClick={
                  onImageClick && !timed ? () => onImageClick(i) : undefined
                }
                onLoad={onImageLoad}
              />
            ) : (
              <div className={styles.galleryTileProgress}>
                <span className={styles.transferText}>Waiting...</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {caption && (
        <p className={styles.galleryCaption}>{formatMessage(caption)}</p>
      )}
      <time
        className={styles.time}
        dateTime={new Date(timestamp).toISOString()}
      >
        {time}
      </time>
    </div>
  );
}

export const PREDICTION_BADGE_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#22c55e',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#6366f1',
];

function formatTimeRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

interface PredictionBubbleContentProps {
  predictionId: string;
  predictionTitle?: string;
  predictionOptions: PredictionOption[];
  predictionMyVote?: number;
  predictionDurationMs: number;
  predictionCreatedAt: number;
  predictionState: PredictionState;
  predictionWinnerIndex?: number;
  predictionMode: PredictionMode;
  isModerator: boolean;
  onPredictionVote?: (predictionId: string, optionIndex: number) => void;
  onPredictionChooseOutcome?: (
    predictionId: string,
    winnerIndex: number,
  ) => void;
  onPredictionDelete?: (predictionId: string) => void;
  isSelf: boolean;
  timestamp: number;
}

function PredictionBubbleContent({
  predictionId,
  predictionTitle,
  predictionOptions,
  predictionMyVote,
  predictionDurationMs,
  predictionCreatedAt,
  predictionState,
  predictionWinnerIndex,
  predictionMode,
  isModerator,
  onPredictionVote,
  onPredictionChooseOutcome,
  onPredictionDelete,
  isSelf,
  timestamp,
}: PredictionBubbleContentProps) {
  const [countdownProgress, setCountdownProgress] = useState(0);
  const [isExpired, setIsExpired] = useState(false);
  const [confirmVoteIndex, setConfirmVoteIndex] = useState<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showChooseOutcome, setShowChooseOutcome] = useState(false);

  useEffect(() => {
    if (predictionState !== 'open') return;
    const deadline = predictionCreatedAt + predictionDurationMs;
    const check = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setCountdownProgress(1 - remaining / predictionDurationMs);
      if (remaining <= 0) setIsExpired(true);
    };
    check();
    const interval = setInterval(check, PREDICTION_TIMER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [predictionCreatedAt, predictionDurationMs, predictionState]);

  const totalVotes = predictionOptions.reduce((sum, o) => sum + o.votes, 0);
  const deadline = predictionCreatedAt + predictionDurationMs;
  const remainingMs = Math.max(0, deadline - Date.now());
  const canVote =
    predictionState === 'open' &&
    !isExpired &&
    predictionMyVote === undefined &&
    Boolean(onPredictionVote);
  const isResolved = predictionState === 'resolved';
  const isDeleted = predictionState === 'deleted';
  const isClosed = predictionState === 'open' && isExpired;

  const handleVoteClick = (index: number) => {
    if (!canVote) return;
    setConfirmVoteIndex(index);
  };

  const handleConfirmVote = () => {
    if (confirmVoteIndex === null || !onPredictionVote) return;
    onPredictionVote(predictionId, confirmVoteIndex);
    setConfirmVoteIndex(null);
  };

  const handleDelete = () => {
    onPredictionDelete?.(predictionId);
    setShowDeleteConfirm(false);
  };

  const ts = new Date(timestamp);
  const timeStr = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}`;

  return (
    <div className={styles.predictionContent}>
      <p className={styles.predictionTitle}>{predictionTitle}</p>

      {isDeleted && (
        <span
          className={`${styles.predictionStateBadge} ${styles.predictionStateDeleted}`}
        >
          Prediction deleted
        </span>
      )}
      {isResolved &&
        predictionWinnerIndex !== undefined &&
        predictionOptions[predictionWinnerIndex] && (
          <span
            className={`${styles.predictionStateBadge} ${styles.predictionStateResolved}`}
          >
            Outcome: {predictionOptions[predictionWinnerIndex].text}
          </span>
        )}
      {isClosed && (
        <span
          className={`${styles.predictionStateBadge} ${styles.predictionStateClosed}`}
        >
          Voting closed
        </span>
      )}

      {predictionState === 'open' && !isExpired && (
        <div className={styles.predictionTimerSection}>
          <div
            className={
              isSelf
                ? `${styles.predictionTimerBar} ${styles.predictionTimerBarSelf}`
                : styles.predictionTimerBar
            }
          >
            <div
              className={
                isSelf
                  ? `${styles.predictionTimerFill} ${styles.predictionTimerFillSelf}`
                  : styles.predictionTimerFill
              }
              style={{ width: `${(1 - countdownProgress) * 100}%` }}
            />
          </div>
          <span className={styles.predictionTimeLabel}>
            {formatTimeRemaining(remainingMs)}
          </span>
        </div>
      )}

      {predictionMode === 'yesno' && predictionOptions.length === 2 ? (
        <div className={styles.yesnoPrediction}>
          <div className={styles.yesnoPercentages}>
            <button
              type='button'
              className={`${styles.yesnoSide} ${styles.yesnoYes}${isSelf ? ` ${styles.yesnoYesSelf}` : ''}${predictionMyVote === 0 ? ` ${styles.yesnoSideSelected}` : ''}${isResolved && predictionWinnerIndex === 0 ? ` ${styles.yesnoSideWinner}` : ''}`}
              disabled={!canVote}
              onClick={() => handleVoteClick(0)}
            >
              {canVote && <span className={styles.yesnoVoteTag}>Vote</span>}
              <span className={styles.yesnoLabel}>Yes</span>
              <span className={styles.yesnoPct}>
                {totalVotes > 0
                  ? Math.round(
                      ((predictionOptions[0]?.votes ?? 0) / totalVotes) * 100,
                    )
                  : 0}
                %
              </span>
            </button>
            <button
              type='button'
              className={`${styles.yesnoSide} ${styles.yesnoNo}${predictionMyVote === 1 ? ` ${styles.yesnoSideSelected}` : ''}${isResolved && predictionWinnerIndex === 1 ? ` ${styles.yesnoSideWinner}` : ''}`}
              disabled={!canVote}
              onClick={() => handleVoteClick(1)}
            >
              {canVote && <span className={styles.yesnoVoteTag}>Vote</span>}
              <span className={styles.yesnoLabel}>No</span>
              <span className={styles.yesnoPct}>
                {totalVotes > 0
                  ? Math.round(
                      ((predictionOptions[1]?.votes ?? 0) / totalVotes) * 100,
                    )
                  : 0}
                %
              </span>
            </button>
          </div>
          <div
            className={`${styles.yesnoBar}${isSelf ? ` ${styles.yesnoBarSelf}` : ''}`}
          >
            <div
              className={`${styles.yesnoBarYes}${isSelf ? ` ${styles.yesnoBarYesSelf}` : ''}`}
              style={{
                width:
                  totalVotes > 0
                    ? `${((predictionOptions[0]?.votes ?? 0) / totalVotes) * 100}%`
                    : '50%',
              }}
            />
          </div>
        </div>
      ) : (
        <div className={styles.predictionOptions}>
          {predictionOptions.map((opt, i) => {
            const pct = totalVotes > 0 ? (opt.votes / totalVotes) * 100 : 0;
            const isWinner = isResolved && predictionWinnerIndex === i;
            const isVoted = predictionMyVote === i;
            const disabled = !canVote || isDeleted || isResolved || isClosed;

            return (
              <div key={i}>
                <button
                  type='button'
                  className={`${styles.predictionOption} ${isSelf ? styles.predictionOptionSelf : styles.predictionOptionPeer}${isWinner ? ` ${styles.predictionOptionWinner}` : ''}${isDeleted ? ` ${styles.predictionOptionDisabled}` : ''}${isVoted ? ` ${styles.predictionOptionSelected}` : ''}`}
                  disabled={disabled}
                  onClick={() => handleVoteClick(i)}
                >
                  <div
                    className={`${styles.predictionProgressBar} ${isSelf ? styles.predictionProgressBarSelf : styles.predictionProgressBarPeer}${isWinner ? ` ${styles.predictionProgressBarWinner}` : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                  <span className={styles.predictionIndicator}>
                    {isWinner ? '\u2713' : isVoted ? '\u25C9' : '\u25CB'}
                  </span>
                  <span className={styles.predictionOptionText}>
                    {opt.text}
                  </span>
                  <span className={styles.predictionVoteCount}>
                    {opt.votes}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {isModerator && predictionState === 'open' && (
        <div className={styles.predictionModeratorControls}>
          <button
            type='button'
            className={styles.predictionDeleteBtn}
            onClick={() => setShowDeleteConfirm(true)}
          >
            Delete
          </button>
          <button
            type='button'
            className={`${styles.predictionChooseBtn}${isClosed ? ` ${styles.predictionChooseBtnPulse}` : ''}`}
            onClick={() => setShowChooseOutcome(true)}
          >
            Choose Outcome
          </button>
        </div>
      )}

      <div className={styles.predictionFooter}>
        <span>
          {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
        </span>
        <span>{timeStr}</span>
      </div>

      {confirmVoteIndex !== null && (
        <ConfirmModal
          title='Your Prediction'
          description={
            predictionMode === 'yesno' ? (
              <>
                You predict that for
                <br />
                <strong>{predictionTitle?.replace(/\?$/, '')}</strong>
                <br />
                the outcome is
                <br />
                <strong>{confirmVoteIndex === 0 ? 'Yes' : 'No'}</strong>
              </>
            ) : (
              <>
                You predict that for
                <br />
                <strong>{predictionTitle?.replace(/\?$/, '')}</strong>
                <br />
                the outcome is
                <br />
                <strong>{predictionOptions[confirmVoteIndex]?.text}</strong>
              </>
            )
          }
          onConfirm={handleConfirmVote}
          onClose={() => setConfirmVoteIndex(null)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmModal
          title='Delete this prediction?'
          description='All votes will be lost.'
          confirmText='Delete'
          confirmIntent='destructive'
          onConfirm={handleDelete}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}

      {showChooseOutcome && predictionTitle && (
        <ChooseOutcomeModal
          predictionTitle={predictionTitle}
          options={predictionOptions}
          onChoose={(winnerIndex) => {
            onPredictionChooseOutcome?.(predictionId, winnerIndex);
            setShowChooseOutcome(false);
          }}
          onClose={() => setShowChooseOutcome(false)}
        />
      )}
    </div>
  );
}

export function MessageBubble({
  kind = 'text',
  text,
  audioUrl,
  durationMs,
  fileUrl,
  fileName,
  fileMimeType,
  fileSize,
  transferProgress,
  sender,
  displayName,
  timestamp,
  reactions = [],
  replyTo,
  replyPreview,
  msgId,
  onReact,
  onReply,
  onReplyClick,
  onCopy,
  onDownload,
  skipAnimation,
  recentEmojis = [],
  timed,
  onTimedExpire,
  onPlayOnceComplete,
  timedConsumed,
  waveform,
  autoPlay,
  onAudioEnded,
  onImageClick,
  pollQuestion,
  pollEmoji,
  pollOptions,
  pollAllowMultiple,
  pollMyVotes,
  pollId,
  onPollVote,
  predictionId,
  predictionTitle,
  predictionOptions,
  predictionMyVote,
  predictionDurationMs,
  predictionCreatedAt,
  predictionState,
  predictionWinnerIndex,
  predictionMode,
  isModerator,
  onPredictionVote,
  onPredictionChooseOutcome,
  onPredictionDelete,
  predictionBadge,
  notefadeUrl,
  notefadeRevealedText,
  notefadeRevealed,
  notefadeDestroyed,
  onRevealNotefade,
  onDestroyNotefade,
  gallery,
  onGalleryImageClick,
  senderColor: senderColorProp,
  resolveReactorName,
  onImageLoad,
}: MessageBubbleProps) {
  const [pickerMode, setPickerMode] = useState<PickerMode>('closed');
  const [showReactionDetail, setShowReactionDetail] = useState(false);
  const [copyDone, setCopyDone] = useState(false);
  const [compact, setCompact] = useState(false);
  const [timedTimerProgress, setTimedTimerProgress] = useState(0);
  const [fadingOut, setFadingOut] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [textClamped, setTextClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTimedExpireRef = useRef(onTimedExpire);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement>(null);
  const reactionPillRef = useRef<HTMLButtonElement>(null);

  onTimedExpireRef.current = onTimedExpire;

  // Timed text messages: auto-start countdown on render
  useEffect(() => {
    if (!timed || !msgId || kind === 'audio') return;
    const ttl = TIMED_MESSAGE_TTL_MS;
    const startTime = Date.now();

    timedIntervalRef.current = setInterval(() => {
      setTimedTimerProgress(Math.min(1, (Date.now() - startTime) / ttl));
    }, 50);

    timedTimerRef.current = setTimeout(() => {
      if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
      setTimedTimerProgress(1);
      setFadingOut(true);
      setTimeout(
        () => onTimedExpireRef.current?.(msgId),
        TIMED_MESSAGE_FADEOUT_MS,
      );
    }, ttl);

    return () => {
      if (timedTimerRef.current) clearTimeout(timedTimerRef.current);
      if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
    };
  }, [timed, msgId, kind]);

  // Timed audio: fallback TTL timer (receiver never plays, or sender never gets consumed signal)
  useEffect(() => {
    if (!timed || !msgId || kind !== 'audio') return;
    const ttl = TIMED_VOICE_FALLBACK_TTL_MS;
    const startTime = Date.now();

    timedIntervalRef.current = setInterval(() => {
      setTimedTimerProgress(Math.min(1, (Date.now() - startTime) / ttl));
    }, 50);

    timedTimerRef.current = setTimeout(() => {
      if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
      setTimedTimerProgress(1);
      setFadingOut(true);
      setTimeout(
        () => onTimedExpireRef.current?.(msgId),
        TIMED_MESSAGE_FADEOUT_MS,
      );
    }, ttl);

    return () => {
      if (timedTimerRef.current) clearTimeout(timedTimerRef.current);
      if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
    };
  }, [timed, msgId, kind]);

  // Handle timedConsumed signal (sender side): peer listened, start fade
  useEffect(() => {
    if (!timedConsumed || !msgId) return;
    if (timedTimerRef.current) clearTimeout(timedTimerRef.current);
    if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
    setFadingOut(true);
    const t = setTimeout(
      () => onTimedExpireRef.current?.(msgId),
      TIMED_MESSAGE_FADEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [timedConsumed, msgId]);

  const handleAudioPlayOnceComplete = useCallback(() => {
    if (!msgId || !timed) return;
    // Cancel fallback timer
    if (timedTimerRef.current) clearTimeout(timedTimerRef.current);
    if (timedIntervalRef.current) clearInterval(timedIntervalRef.current);
    // Notify parent (sends timed-consumed signal)
    onPlayOnceComplete?.(msgId);
    // Start fade-out
    setFadingOut(true);
    setTimeout(
      () => onTimedExpireRef.current?.(msgId),
      TIMED_MESSAGE_FADEOUT_MS,
    );
  }, [msgId, timed, onPlayOnceComplete]);

  const handleAudioEnded = useCallback(() => {
    if (!msgId) return;
    onAudioEnded?.(msgId);
  }, [msgId, onAudioEnded]);

  const handleCopy = useCallback(() => {
    if (!onCopy || copyDone) return;
    onCopy();
    setCopyDone(true);
    copyTimerRef.current = setTimeout(() => setCopyDone(false), 1200);
  }, [onCopy, copyDone]);

  const handleDoubleClick = useCallback(() => {
    if (onReact && sender !== 'system') {
      setPickerMode((prev) => (prev === 'closed' ? 'compact' : 'closed'));
    }
  }, [onReact, sender]);

  const handleTouchStart = useCallback(() => {
    if (!onReact || sender === 'system') return;
    longPressRef.current = setTimeout(() => {
      setPickerMode('compact');
    }, 500);
  }, [onReact, sender]);

  const handleTouchEnd = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (longPressRef.current) clearTimeout(longPressRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setCompact(el.offsetHeight < 100);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = textRef.current;
    if (!el || kind !== 'text') return;
    setTextClamped(el.scrollHeight > el.clientHeight);
  }, [text, kind]);

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      setPickerMode('closed');
      onReact?.(emoji);
    },
    [onReact],
  );

  const handleExpand = useCallback(() => {
    setPickerMode('expanded');
  }, []);

  const handlePillClick = useCallback(() => {
    setShowReactionDetail((prev) => {
      if (!prev) setPickerMode('closed');
      return !prev;
    });
  }, []);

  if (sender === 'system') {
    return (
      <div
        className={`${styles.system}${skipAnimation ? ` ${styles.noAnimation}` : ''}`}
        role='listitem'
      >
        <p className={styles.systemText}>{text ?? ''}</p>
      </div>
    );
  }

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const isSelf = sender === 'self';
  const grouped = groupReactions(reactions);
  const hasReactions = grouped.length > 0;
  const emojiOnly = kind === 'text' && !!text && isEmojiOnly(text);

  const anchorRect = emojiTriggerRef.current?.getBoundingClientRect();

  return (
    <div
      className={`${styles.bubbleWrapper} ${isSelf ? styles.bubbleWrapperSelf : styles.bubbleWrapperPeer}${kind === 'audio' ? ` ${styles.bubbleWrapperAudio}` : ''}${kind === 'image' ? ` ${styles.bubbleWrapperImage}` : ''}${kind === 'video' ? ` ${styles.bubbleWrapperVideo}` : ''}${kind === 'file' ? ` ${styles.bubbleWrapperFile}` : ''}${kind === 'gallery' ? ` ${styles.bubbleWrapperGallery}` : ''}${kind === 'notefade' || kind === 'notefade-chat' ? ` ${styles.bubbleWrapperNotefade}` : ''}${hasReactions ? ` ${styles.bubbleWrapperHasReactions}` : ''}${emojiOnly ? ` ${styles.bubbleWrapperEmoji}` : ''}${fadingOut ? ` ${styles.timedFadingOut}` : ''}`}
      data-msg-id={msgId}
      role='listitem'
    >
      <div
        ref={bubbleRef}
        className={`${styles.bubble} ${isSelf ? styles.self : styles.peer}${compact && kind !== 'audio' ? ` ${styles.compactActions}` : ''}${kind === 'audio' ? ` ${styles.audioActions}` : ''}${emojiOnly ? ` ${styles.emojiOnlyBubble}` : ''}${skipAnimation ? ` ${styles.noAnimation}` : ''}`}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {displayName && (
          <p
            className={styles.displayName}
            style={senderColorProp ? { color: senderColorProp } : undefined}
          >
            {displayName}
            {predictionBadge && (
              <span
                className={styles.predictionBadge}
                style={{ background: predictionBadge.color }}
              >
                {predictionBadge.text}
              </span>
            )}
          </p>
        )}
        {replyTo && replyPreview && (
          <div
            className={`${styles.quoteBlock}${onReplyClick ? ` ${styles.quoteBlockClickable}` : ''}`}
            onClick={onReplyClick}
            role={onReplyClick ? 'button' : undefined}
          >
            <span className={styles.quoteText}>{replyPreview}</span>
          </div>
        )}
        {kind === 'audio' && audioUrl ? (
          <AudioPlayer
            src={audioUrl}
            durationMs={durationMs}
            waveform={waveform}
            isSelf={isSelf}
            timestamp={timestamp}
            timed={timed}
            onPlayOnceComplete={
              timed && !isSelf ? handleAudioPlayOnceComplete : undefined
            }
            autoPlay={autoPlay}
            onAudioEnded={handleAudioEnded}
          />
        ) : kind === 'image' ? (
          <div className={styles.imageContainer}>
            {timed && (
              <span className={styles.timedBadge}>
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
                timed
              </span>
            )}
            {transferProgress !== undefined ? (
              <div className={styles.transferPlaceholder}>
                <div className={styles.transferProgressBar}>
                  <div
                    className={`${styles.transferProgressFill} ${isSelf ? styles.transferProgressFillSelf : styles.transferProgressFillPeer}`}
                    style={{ width: `${Math.round(transferProgress * 100)}%` }}
                  />
                </div>
                <span className={styles.transferText}>
                  {Math.round(transferProgress * 100)}%
                  {fileSize ? ` of ${formatFileSize(fileSize)}` : ''}
                </span>
              </div>
            ) : fileUrl ? (
              <img
                className={styles.imageContent}
                src={fileUrl}
                alt={fileName ?? 'Image'}
                loading='lazy'
                onClick={onImageClick}
                onLoad={onImageLoad}
              />
            ) : null}
            <div className={styles.imageFooter}>
              {fileName && (
                <span className={styles.imageFileName}>{fileName}</span>
              )}
              <time
                className={styles.time}
                dateTime={new Date(timestamp).toISOString()}
              >
                {time}
              </time>
            </div>
          </div>
        ) : kind === 'video' ? (
          <div className={styles.videoContainer}>
            {timed && (
              <span className={styles.timedBadge}>
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
                timed
              </span>
            )}
            {transferProgress !== undefined ? (
              <div className={styles.transferPlaceholder}>
                <div className={styles.transferProgressBar}>
                  <div
                    className={`${styles.transferProgressFill} ${isSelf ? styles.transferProgressFillSelf : styles.transferProgressFillPeer}`}
                    style={{ width: `${Math.round(transferProgress * 100)}%` }}
                  />
                </div>
                <span className={styles.transferText}>
                  {Math.round(transferProgress * 100)}%
                  {fileSize ? ` of ${formatFileSize(fileSize)}` : ''}
                </span>
              </div>
            ) : fileUrl ? (
              <video
                className={styles.videoContent}
                src={fileUrl}
                controls
                preload='metadata'
                playsInline
              />
            ) : null}
            <div className={styles.videoFooter}>
              {fileName && (
                <span className={styles.videoFileName} title={fileName}>{fileName}</span>
              )}
              <time
                className={styles.time}
                dateTime={new Date(timestamp).toISOString()}
              >
                {time}
              </time>
            </div>
          </div>
        ) : kind === 'file' &&
          fileMimeType?.startsWith('audio/') &&
          fileUrl &&
          transferProgress === undefined ? (
          <div className={styles.audioFileCard}>
            {timed && (
              <span className={styles.timedBadge}>
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
                timed
              </span>
            )}
            <AudioPlayer
              src={fileUrl}
              waveform={waveform}
              isSelf={isSelf}
              timestamp={timestamp}
              timed={timed}
              onPlayOnceComplete={
                timed && !isSelf ? handleAudioPlayOnceComplete : undefined
              }
              onAudioEnded={handleAudioEnded}
            />
            <div className={styles.audioFileMeta}>
              <span className={styles.audioFileName}>{fileName}</span>
              {fileSize ? (
                <span className={styles.audioFileSize}>
                  {formatFileSize(fileSize)}
                </span>
              ) : null}
            </div>
          </div>
        ) : kind === 'file' ? (
          <div className={styles.fileCard}>
            {timed && (
              <span className={styles.timedBadge}>
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
                timed
              </span>
            )}
            <div className={styles.fileCardBody}>
              <svg
                className={styles.fileIcon}
                width='28'
                height='28'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                <polyline points='14 2 14 8 20 8' />
              </svg>
              <div className={styles.fileInfo}>
                <span className={styles.fileName}>{fileName ?? 'File'}</span>
                <span className={styles.fileMeta}>
                  {fileSize ? formatFileSize(fileSize) : ''}
                  {fileMimeType
                    ? ` · ${fileMimeType.split('/')[1] ?? fileMimeType}`
                    : ''}
                </span>
              </div>
            </div>
            {transferProgress !== undefined ? (
              <div className={styles.transferProgressBar}>
                <div
                  className={`${styles.transferProgressFill} ${isSelf ? styles.transferProgressFillSelf : styles.transferProgressFillPeer}`}
                  style={{ width: `${Math.round(transferProgress * 100)}%` }}
                />
              </div>
            ) : null}
            <time
              className={styles.time}
              dateTime={new Date(timestamp).toISOString()}
            >
              {time}
            </time>
          </div>
        ) : kind === 'poll' && pollOptions && pollId ? (
          <PollBubbleContent
            pollId={pollId}
            pollEmoji={pollEmoji}
            pollQuestion={pollQuestion}
            pollOptions={pollOptions}
            pollAllowMultiple={pollAllowMultiple}
            pollMyVotes={pollMyVotes}
            onPollVote={onPollVote}
            isSelf={isSelf}
            timestamp={timestamp}
          />
        ) : kind === 'prediction' &&
          predictionOptions &&
          predictionId &&
          predictionState &&
          predictionDurationMs !== undefined &&
          predictionCreatedAt !== undefined ? (
          <PredictionBubbleContent
            predictionId={predictionId}
            predictionTitle={predictionTitle}
            predictionOptions={predictionOptions}
            predictionMyVote={predictionMyVote}
            predictionDurationMs={predictionDurationMs}
            predictionCreatedAt={predictionCreatedAt}
            predictionState={predictionState}
            predictionWinnerIndex={predictionWinnerIndex}
            predictionMode={predictionMode ?? 'complex'}
            isModerator={isModerator ?? false}
            onPredictionVote={onPredictionVote}
            onPredictionChooseOutcome={onPredictionChooseOutcome}
            onPredictionDelete={onPredictionDelete}
            isSelf={isSelf}
            timestamp={timestamp}
          />
        ) : kind === 'gallery' && gallery ? (
          <GalleryBubbleContent
            gallery={gallery}
            caption={text}
            isSelf={isSelf}
            timestamp={timestamp}
            timed={timed}
            onImageClick={onGalleryImageClick}
            onImageLoad={onImageLoad}
          />
        ) : kind === 'notefade' && notefadeUrl ? (
          <>
            <a
              href={notefadeUrl}
              target='_blank'
              rel='noopener noreferrer'
              className={styles.notefadeCard}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.notefadeCardHeader}>
                <IconNotefade size={18} />
                <span className={styles.notefadeCardTitle}>
                  Self-destructing note
                </span>
              </div>
              <p className={styles.notefadeCardBody}>
                Tap to open on notefade.com - this note will self-destruct after
                reading.
              </p>
              <span className={styles.notefadeCardDomain}>notefade.com</span>
            </a>
            <time
              className={styles.time}
              dateTime={new Date(timestamp).toISOString()}
            >
              {time}
            </time>
          </>
        ) : kind === 'notefade-chat' && notefadeUrl ? (
          <>
            <div className={styles.notefadeChatCard}>
              <div className={styles.notefadeCardHeader}>
                <IconNotefade size={18} />
                <span className={styles.notefadeCardTitle}>Secret note</span>
              </div>
              {notefadeDestroyed ? (
                <span className={styles.notefadeStatusLabel}>
                  Note was destroyed
                </span>
              ) : isSelf ? (
                notefadeRevealed ? (
                  <span className={styles.notefadeStatusLabel}>
                    Note was revealed
                  </span>
                ) : (
                  <>
                    <p className={styles.notefadeCardBody}>
                      Waiting for recipient to reveal this note.
                    </p>
                    <button
                      type='button'
                      className={styles.notefadeDestroyBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (msgId && onDestroyNotefade) {
                          onDestroyNotefade(msgId, notefadeUrl);
                        }
                      }}
                    >
                      Destroy before read
                    </button>
                  </>
                )
              ) : notefadeRevealedText ? (
                <>
                  <p className={styles.notefadeRevealedText}>
                    {notefadeRevealedText}
                  </p>
                  <span className={styles.notefadeRevealedLabel}>Revealed</span>
                </>
              ) : (
                <>
                  <p className={styles.notefadeCardBody}>
                    Click to reveal - this note will self-destruct after
                    reading.
                  </p>
                  <button
                    type='button'
                    className={styles.notefadeRevealBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (msgId && onRevealNotefade) {
                        onRevealNotefade(msgId, notefadeUrl);
                      }
                    }}
                  >
                    Reveal
                  </button>
                </>
              )}
            </div>
            <time
              className={styles.time}
              dateTime={new Date(timestamp).toISOString()}
            >
              {time}
            </time>
          </>
        ) : (
          <>
            {timed && (
              <span className={styles.timedBadge}>
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <circle cx='12' cy='12' r='10' />
                  <polyline points='12 6 12 12 16 14' />
                </svg>
                timed
              </span>
            )}
            <p
              ref={kind === 'text' && !emojiOnly ? textRef : undefined}
              className={`${styles.text}${emojiOnly ? ` ${styles.emojiOnly}` : ''}${kind === 'text' && !emojiOnly && !textExpanded ? ` ${styles.textCollapsible}` : ''}`}
            >
              {text ? formatMessage(text) : ''}
            </p>
            {textClamped && !textExpanded && (
              <button
                type='button'
                className={styles.readMore}
                onClick={(e) => {
                  e.stopPropagation();
                  setTextExpanded(true);
                }}
              >
                Read more
              </button>
            )}
            {emojiOnly ? (
              <span
                className={`${styles.emojiOnlyTimePill} ${isSelf ? styles.emojiOnlyTimePillSelf : styles.emojiOnlyTimePillPeer}`}
              >
                <time
                  className={styles.time}
                  dateTime={new Date(timestamp).toISOString()}
                >
                  {time}
                </time>
              </span>
            ) : (
              <time
                className={styles.time}
                dateTime={new Date(timestamp).toISOString()}
              >
                {time}
              </time>
            )}
          </>
        )}
        {timed && (
          <div className={styles.timedTimerBar}>
            <div
              className={styles.timedTimerFill}
              style={{ width: `${(1 - timedTimerProgress) * 100}%` }}
            />
          </div>
        )}
        {onCopy &&
          (kind === 'text' ||
            (kind === 'notefade-chat' && notefadeRevealedText)) &&
          !emojiOnly && (
            <button
              type='button'
              className={`${styles.copyButton} ${copyDone ? styles.copyDone : ''}`}
              onClick={handleCopy}
              aria-label={copyDone ? 'Copied' : 'Copy message'}
            >
              {copyDone ? (
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='3'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <polyline points='20 6 9 17 4 12' />
                </svg>
              ) : (
                <svg
                  width='12'
                  height='12'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                >
                  <rect x='9' y='9' width='13' height='13' rx='2' />
                  <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
                </svg>
              )}
            </button>
          )}
        {onDownload &&
          (kind === 'audio' ||
            kind === 'image' ||
            kind === 'video' ||
            kind === 'file' ||
            kind === 'gallery') && (
            <button
              type='button'
              className={styles.downloadActionButton}
              onClick={onDownload}
              aria-label='Download voice note'
            >
              <svg
                width='12'
                height='12'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M12 3v13m0 0l-4-4m4 4l4-4' />
                <path d='M5 20h14' />
              </svg>
            </button>
          )}
        {onReply && (
          <button
            type='button'
            className={styles.replyButton}
            onClick={onReply}
            aria-label='Reply'
          >
            <svg
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M9 17l-5-5 5-5' />
              <path d='M4 12h11a4 4 0 0 1 0 8h-1' />
            </svg>
          </button>
        )}
        {onReact && (
          <button
            ref={emojiTriggerRef}
            type='button'
            className={styles.emojiTrigger}
            onClick={() => {
              setPickerMode((prev) =>
                prev === 'closed' ? 'compact' : 'closed',
              );
              setShowReactionDetail(false);
            }}
            aria-label='React'
          >
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='12' cy='12' r='10' />
              <path d='M8 14s1.5 2 4 2 4-2 4-2' />
              <line x1='9' y1='9' x2='9.01' y2='9' />
              <line x1='15' y1='9' x2='15.01' y2='9' />
            </svg>
          </button>
        )}
        {hasReactions && (
          <button
            ref={reactionPillRef}
            type='button'
            className={`${styles.reactionPill} ${isSelf ? styles.reactionPillSelf : styles.reactionPillPeer}`}
            onClick={handlePillClick}
          >
            {grouped.map((r) => (
              <span key={r.emoji} className={styles.reactionEmoji}>
                {r.emoji}
              </span>
            ))}
            {reactions.length > 1 && (
              <span className={styles.reactionCount}>{reactions.length}</span>
            )}
          </button>
        )}
      </div>
      {pickerMode === 'compact' && anchorRect && (
        <EmojiQuickPick
          onSelect={handleEmojiSelect}
          onClose={() => setPickerMode('closed')}
          onExpand={handleExpand}
          recentEmojis={recentEmojis}
          anchorRect={anchorRect}
          alignRight={isSelf}
        />
      )}
      {pickerMode === 'expanded' && anchorRect && (
        <EmojiFullPicker
          onSelect={handleEmojiSelect}
          onClose={() => setPickerMode('closed')}
          recentEmojis={recentEmojis}
          anchorRect={anchorRect}
          alignRight={isSelf}
        />
      )}
      {showReactionDetail && reactionPillRef.current && resolveReactorName && (
        <ReactionDetail
          reactions={reactions}
          anchorRect={reactionPillRef.current.getBoundingClientRect()}
          alignRight={isSelf}
          onRemoveReaction={(emoji) => {
            onReact?.(emoji);
            setShowReactionDetail(false);
          }}
          onClose={() => setShowReactionDetail(false)}
          resolveReactorName={resolveReactorName}
        />
      )}
    </div>
  );
}
