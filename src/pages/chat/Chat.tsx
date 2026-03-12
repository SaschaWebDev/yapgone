import { useRef, useEffect, useState, useCallback, type FormEvent } from 'react';
import chatBubbleStyles from '@/components/ui/message-bubble/MessageBubble.module.css';
import { useChatAsCreator, useChatAsJoiner, useVoiceCall, useNotifications, useLocalChatSettings, useInactivityTimer, useRecentEmojis } from '@/hooks';
import type { VoiceSignal } from '@/types';
import type { ChatMessage } from '@/hooks/use-chat';
import type { ConnectionQuality } from '@/components/ui/status-badge/StatusBadge';
import type { RoomSettings } from '@/room-settings';
import {
  DEFAULT_ROOM_SETTINGS,
  createSafeWordSettings,
  normalizeRoomSettings,
  verifySafeWord,
} from '@/room-settings';
import {
  Button,
  MessageBubble,
  ChatInput,
  StatusBadge,
  VoiceControls,
  ScreenShareView,
  IconCopy,
  IconCheck,
  IconGear,
  OnOffToggle,
  QrCode,
  ReplyPreview,
  InactivityCountdown,
} from '@/components';
import {
  MAX_MESSAGE_LENGTH,
  COPY_FLASH_FADE_MS,
  COPY_FLASH_DONE_MS,
  STORAGE_KEYS,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_MAX_DURATION_MS,
  VOICE_NOTE_SIZE_WARNING_THRESHOLD_S,
  VOICE_NOTE_DURATION_WARNING_THRESHOLD_S,
  VOICE_NOTE_SIZE_SAFETY_RATIO,
  VOICE_NOTE_TIMESLICE_MS,
  VOICE_NOTE_AUDIO_BITRATE,
  SAFE_WORD_MAX_ATTEMPTS,
  USERNAME_MAX_LENGTH,
  ROOM_INACTIVITY_TTL_MS,
} from '@/constants';
import styles from './Chat.module.css';

interface ChatProps {
  roomId: string;
  creatorPubKey: string;
  roomSettings: RoomSettings | null;
}

export function Chat({ roomId, creatorPubKey, roomSettings }: ChatProps) {
  const normalizedSettings = normalizeRoomSettings(roomSettings ?? DEFAULT_ROOM_SETTINGS);
  const isCreator =
    sessionStorage.getItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`) === '1';
  const [safeWordPassed, setSafeWordPassed] = useState(false);

  if (isCreator) {
    return <CreatorChat initialRoomSettings={normalizedSettings} />;
  }

  if (normalizedSettings.safeWord && !safeWordPassed) {
    return (
      <SafeWordGate
        roomId={roomId}
        onPassed={() => setSafeWordPassed(true)}
        roomSettings={normalizedSettings}
      />
    );
  }

  return (
    <JoinerChat
      roomId={roomId}
      creatorPubKey={creatorPubKey}
      initialRoomSettings={normalizedSettings}
    />
  );
}

function SafeWordGate({
  roomId,
  roomSettings,
  onPassed,
}: {
  roomId: string;
  roomSettings: RoomSettings;
  onPassed: () => void;
}) {
  const [value, setValue] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [blocked, setBlocked] = useState(
    sessionStorage.getItem(`${STORAGE_KEYS.SAFEWORD_LOCK_PREFIX}${roomId}`) === '1',
  );
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const remaining = Math.max(0, SAFE_WORD_MAX_ATTEMPTS - attempts);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!roomSettings.safeWord || blocked || checking) return;
    setChecking(true);
    const valid = await verifySafeWord(value, roomSettings.safeWord);
    setChecking(false);
    if (valid) {
      setError(null);
      onPassed();
      return;
    }

    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);
    setError('Safe word is incorrect');
    if (nextAttempts >= SAFE_WORD_MAX_ATTEMPTS) {
      sessionStorage.setItem(`${STORAGE_KEYS.SAFEWORD_LOCK_PREFIX}${roomId}`, '1');
      setBlocked(true);
    }
  }, [attempts, blocked, checking, onPassed, roomId, roomSettings.safeWord, value]);

  return (
    <div className={styles.wrapper}>
      <div className={styles.centered}>
        <h2 className={styles.safeWordTitle}>Safe word required</h2>
        <p className={styles.safeWordText}>
          Enter the out-of-band safe word to open this chat room.
        </p>
        <form className={styles.safeWordForm} onSubmit={handleSubmit}>
          <input
            type='password'
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className={styles.safeWordInput}
            disabled={blocked || checking}
            autoFocus
            placeholder='Safe word'
          />
          <button
            type='submit'
            className={styles.safeWordButton}
            disabled={blocked || checking || value.trim().length === 0}
          >
            {checking ? 'Checking...' : 'Enter chat'}
          </button>
        </form>
        {blocked ? (
          <p className={styles.safeWordBlocked}>
            Too many failed attempts. Reload and use a new invite link.
          </p>
        ) : (
          <p className={styles.safeWordRemaining}>Remaining attempts: {remaining}</p>
        )}
        {error && <p className={styles.errorMessage}>{error}</p>}
      </div>
    </div>
  );
}

function CreatorChat({ initialRoomSettings }: { initialRoomSettings: RoomSettings }) {
  const voiceHandlerRef = useRef<((signal: VoiceSignal) => void) | null>(null);
  const {
    phase,
    messages,
    peerTyping,
    inviteUrl,
    sendMessage,
    sendReaction,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    endChat,
    endChatForAll,
    roomSettings,
    updateRoomSettings,
    usernameModeEnabled,
    localUsername,
    peerUsername,
    setLocalUsername,
    mediaKeyRaw,
    error,
  } = useChatAsCreator(voiceHandlerRef, initialRoomSettings);

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
    mediaKeyRaw,
  });

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={inviteUrl}
      error={error}
      onSend={sendMessage}
      onReact={sendReaction}
      onTyping={sendTyping}
      onSendVoiceNote={sendVoiceNote}
      onEnd={endChat}
      onEndForAll={endChatForAll}
      roomSettings={roomSettings}
      onUpdateRoomSettings={updateRoomSettings}
      usernameModeEnabled={usernameModeEnabled}
      localUsername={localUsername}
      peerUsername={peerUsername}
      onSetLocalUsername={setLocalUsername}
      voice={voice}
    />
  );
}

function JoinerChat({
  roomId,
  creatorPubKey,
  initialRoomSettings,
}: {
  roomId: string;
  creatorPubKey: string;
  initialRoomSettings: RoomSettings;
}) {
  const voiceHandlerRef = useRef<((signal: VoiceSignal) => void) | null>(null);
  const {
    phase,
    messages,
    peerTyping,
    sendMessage,
    sendReaction,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    endChat,
    endChatForAll,
    roomSettings,
    usernameModeEnabled,
    localUsername,
    peerUsername,
    setLocalUsername,
    mediaKeyRaw,
    error,
  } = useChatAsJoiner(roomId, creatorPubKey, initialRoomSettings, voiceHandlerRef);

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
    mediaKeyRaw,
  });

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={null}
      error={error}
      onSend={sendMessage}
      onReact={sendReaction}
      onTyping={sendTyping}
      onSendVoiceNote={sendVoiceNote}
      onEnd={endChat}
      onEndForAll={endChatForAll}
      roomSettings={roomSettings}
      onUpdateRoomSettings={undefined}
      usernameModeEnabled={usernameModeEnabled}
      localUsername={localUsername}
      peerUsername={peerUsername}
      onSetLocalUsername={setLocalUsername}
      voice={voice}
    />
  );
}

function deriveConnectionQuality(phase: string, msgs: ChatMessage[]): ConnectionQuality {
  if (phase === 'peer-disconnected') return 'degraded'
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg?.sender !== 'system') continue
    if (msg.text === 'Connection lost, reconnecting...') return 'reconnecting'
    if (msg.text === 'Failed to reconnect') return 'lost'
    break
  }
  return 'good'
}

async function computeWaveform(blob: Blob): Promise<number[]> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const data = audioBuffer.getChannelData(0);
    const barCount = 40;
    const step = Math.floor(data.length / barCount);
    const peaks: number[] = [];
    for (let i = 0; i < barCount; i++) {
      let max = 0;
      for (let j = 0; j < step; j++) {
        const v = Math.abs(data[i * step + j] ?? 0);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const maxPeak = Math.max(...peaks, 0.01);
    await audioCtx.close();
    return peaks.map((p) => p / maxPeak);
  } catch {
    return Array.from({ length: 40 }, () => 0.5);
  }
}

interface VoiceState {
  callState: import('@/types').CallState;
  isMuted: boolean;
  callDuration: number;
  privacyAcknowledged: boolean;
  isScreenSharing: boolean;
  remoteScreenStream: MediaStream | null;
  isDeafened: boolean;
  isE2eeEnabled: boolean;
  isReconnecting: boolean;
  startCall: () => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleE2ee: () => void;
  acknowledgePrivacy: () => void;
  resetCallState: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
}

interface ChatViewProps {
  phase: string;
  messages: ChatMessage[];
  peerTyping: boolean;
  inviteUrl: string | null;
  error: string | null;
  onSend: (text: string, replyTo?: string) => void;
  onReact: (msgId: string, emoji: string, action: 'add' | 'remove') => void;
  onTyping: (active: boolean) => void;
  onSendVoiceNote: (blob: Blob, durationMs: number, mimeType: string) => Promise<void>;
  onEnd: () => void;
  onEndForAll: () => void;
  roomSettings: RoomSettings;
  onUpdateRoomSettings?: (settings: RoomSettings) => void;
  usernameModeEnabled: boolean;
  localUsername: string | null;
  peerUsername: string | null;
  onSetLocalUsername: (username: string) => Promise<void>;
  voice: VoiceState;
}

function ChatView({
  phase,
  messages,
  peerTyping,
  inviteUrl,
  error,
  onSend,
  onReact,
  onTyping,
  onSendVoiceNote,
  onEnd,
  onEndForAll,
  roomSettings,
  onUpdateRoomSettings,
  usernameModeEnabled,
  localUsername,
  peerUsername,
  onSetLocalUsername,
  voice,
}: ChatViewProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showEndForMeOptions, setShowEndForMeOptions] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'shown' | 'fading'>(
    'idle',
  );
  const [isRecordingNote, setIsRecordingNote] = useState(false);
  const [voiceNoteError, setVoiceNoteError] = useState<string | null>(null);
  const [isSendingVoiceNote, setIsSendingVoiceNote] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [voiceNoteSizeWarningSeconds, setVoiceNoteSizeWarningSeconds] = useState<number | null>(null);
  const [voiceNoteTimeWarningSeconds, setVoiceNoteTimeWarningSeconds] = useState<number | null>(null);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDurationMs, setPreviewDurationMs] = useState(0);
  const [previewWaveform, setPreviewWaveform] = useState<number[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingSafeWordEnabled, setPendingSafeWordEnabled] = useState(Boolean(roomSettings.safeWord));
  const [pendingSafeWord, setPendingSafeWord] = useState('');
  const [pendingUsernameMode, setPendingUsernameMode] = useState(roomSettings.usernameModeEnabled);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [applyingSafeWord, setApplyingSafeWord] = useState(false);
  const [safeWordApplied, setSafeWordApplied] = useState(false);
  const safeWordAppliedRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingUsername, setPendingUsername] = useState('');
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [inputFocusTrigger, setInputFocusTrigger] = useState(0);
  const isAtBottomRef = useRef(true);
  const safeWordDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceNoteChunksRef = useRef<Blob[]>([]);
  const voiceNoteStartedAtRef = useRef<number | null>(null);
  const voiceNoteStreamRef = useRef<MediaStream | null>(null);
  const voiceNoteAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedBytesRef = useRef(0);
  const pauseStartedAtRef = useRef<number | null>(null);
  const totalPausedMsRef = useRef(0);
  const autoStopRemainingMsRef = useRef(VOICE_NOTE_MAX_DURATION_MS);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(messages.length);
  const localSettingsRef = useRef<HTMLDivElement>(null);
  const copied = copyState !== 'idle';

  const { settings: localSettings, updateSetting } = useLocalChatSettings();
  const { recentEmojis, trackEmoji } = useRecentEmojis();

  const { remainingSeconds, resetTimer } = useInactivityTimer(ROOM_INACTIVITY_TTL_MS);

  useNotifications(messages, phase, localSettings.soundEnabled);

  // Reset inactivity timer on any new message (sent or received)
  useEffect(() => {
    if (messages.length > 0) resetTimer();
  }, [messages.length, resetTimer]);

  // Reset inactivity timer when peer starts typing
  useEffect(() => {
    if (peerTyping) resetTimer();
  }, [peerTyping, resetTimer]);

  // Wrap onTyping to also reset inactivity timer
  const handleTyping = useCallback((active: boolean) => {
    if (active) resetTimer();
    onTyping(active);
  }, [onTyping, resetTimer]);

  const handleCopy = useCallback(async () => {
    if (!inviteUrl || copyState !== 'idle') return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      const input = document.createElement('input');
      input.value = inviteUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopyState('shown');
    setTimeout(() => setCopyState('fading'), COPY_FLASH_FADE_MS);
    setTimeout(() => setCopyState('idle'), COPY_FLASH_DONE_MS);
  }, [inviteUrl, copyState]);

  const handleNewChat = useCallback(() => {
    window.location.hash = '';
  }, []);

  const handleSend = useCallback((text: string) => {
    onSend(text, replyingTo?.id);
    setReplyingTo(null);
  }, [onSend, replyingTo]);

  const handleCopyMessage = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const input = document.createElement('input')
      input.value = text
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    }
  }, [])

  const scrollToMessage = useCallback((targetMsgId: string) => {
    const el = document.querySelector(`[data-msg-id="${targetMsgId}"]`);
    const cls = chatBubbleStyles.highlighted;
    if (!el || !cls) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add(cls);
    const onEnd = () => {
      el.classList.remove(cls);
      el.removeEventListener('animationend', onEnd);
    };
    el.addEventListener('animationend', onEnd);
  }, []);

  const handleReact = useCallback((msgId: string, emoji: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    const alreadyReacted = msg.reactions.some(r => r.emoji === emoji && r.fromSelf);
    trackEmoji(emoji);
    onReact(msgId, emoji, alreadyReacted ? 'remove' : 'add');
  }, [messages, onReact, trackEmoji]);

  const newChatButton = (
    <button className={styles.restartLink} onClick={handleNewChat}>
      Start a new conversation
    </button>
  );

  // Auto-scroll logic
  useEffect(() => {
    const newCount = messages.length;
    const added = newCount - prevMessageCountRef.current;
    prevMessageCountRef.current = newCount;

    if (added <= 0) return;

    if (localSettings.autoScroll) {
      // Auto-scroll always when enabled
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnreadBelow(0);
    } else if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      const newPeerMessages = messages.slice(-added).filter((m) => m.sender === 'peer');
      if (newPeerMessages.length > 0) {
        setUnreadBelow((prev) => prev + newPeerMessages.length);
      }
    }
  }, [messages.length, messages, localSettings.autoScroll]);

  const handleMessageListScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isAtBottomRef.current = atBottom;
    if (atBottom) setUnreadBelow(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setUnreadBelow(0);
  }, []);

  // Close local settings dropdown on outside click
  useEffect(() => {
    if (!localSettingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (localSettingsRef.current && !localSettingsRef.current.contains(e.target as Node)) {
        setLocalSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [localSettingsOpen]);

  // Escape key dismissal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (localSettingsOpen) {
        setLocalSettingsOpen(false);
      } else if (replyingTo) {
        setReplyingTo(null);
      } else if (showEndConfirm) {
        setShowEndConfirm(false);
      } else if (showEndForMeOptions) {
        setShowEndForMeOptions(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [localSettingsOpen, replyingTo, showEndConfirm, showEndForMeOptions]);

  useEffect(() => {
    if (localUsername) {
      setPendingUsername(localUsername);
    }
  }, [localUsername]);

  useEffect(() => {
    return () => {
      if (safeWordDebounceRef.current) {
        clearTimeout(safeWordDebounceRef.current);
      }
      if (safeWordAppliedRef.current) {
        clearTimeout(safeWordAppliedRef.current);
      }
      if (voiceNoteAutoStopRef.current) {
        clearTimeout(voiceNoteAutoStopRef.current);
      }
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (voiceNoteStreamRef.current) {
        voiceNoteStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Revoke preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const clearVoiceNoteRecorder = useCallback(() => {
    if (voiceNoteAutoStopRef.current) {
      clearTimeout(voiceNoteAutoStopRef.current);
      voiceNoteAutoStopRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    if (voiceNoteStreamRef.current) {
      voiceNoteStreamRef.current.getTracks().forEach((track) => track.stop());
      voiceNoteStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    voiceNoteChunksRef.current = [];
    voiceNoteStartedAtRef.current = null;
    accumulatedBytesRef.current = 0;
    pauseStartedAtRef.current = null;
    totalPausedMsRef.current = 0;
    autoStopRemainingMsRef.current = VOICE_NOTE_MAX_DURATION_MS;
    setIsRecordingNote(false);
    setIsRecordingPaused(false);
    setRecordingDuration(0);
    setVoiceNoteSizeWarningSeconds(null);
    setVoiceNoteTimeWarningSeconds(null);
    // Clear preview state
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPreviewDurationMs(0);
    setPreviewWaveform([]);
  }, []);


  const startVoiceNoteRecording = useCallback(async () => {
    if (isRecordingNote || isSendingVoiceNote) return;
    setVoiceNoteError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceNoteStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: VOICE_NOTE_AUDIO_BITRATE,
      });
      mediaRecorderRef.current = recorder;
      voiceNoteChunksRef.current = [];
      voiceNoteStartedAtRef.current = Date.now();
      accumulatedBytesRef.current = 0;
      pauseStartedAtRef.current = null;
      totalPausedMsRef.current = 0;
      autoStopRemainingMsRef.current = VOICE_NOTE_MAX_DURATION_MS;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceNoteChunksRef.current.push(event.data);
          accumulatedBytesRef.current += event.data.size;

          const elapsedMs = Date.now() - (voiceNoteStartedAtRef.current ?? Date.now()) - totalPausedMsRef.current;
          const elapsedSeconds = elapsedMs / 1000;
          if (elapsedSeconds > 0) {
            const bytesPerSecond = accumulatedBytesRef.current / elapsedSeconds;
            const maxBytes = VOICE_NOTE_MAX_BYTES * VOICE_NOTE_SIZE_SAFETY_RATIO;
            const remainingBytes = maxBytes - accumulatedBytesRef.current;

            if (remainingBytes <= 0) {
              recorder.stop();
              return;
            }

            const remainingSeconds = Math.ceil(remainingBytes / bytesPerSecond);
            if (remainingSeconds <= VOICE_NOTE_SIZE_WARNING_THRESHOLD_S) {
              setVoiceNoteSizeWarningSeconds(remainingSeconds);
            }
          }
        }
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(voiceNoteChunksRef.current, { type: mimeType });
        const durationMs = Math.max(0, Date.now() - (voiceNoteStartedAtRef.current ?? Date.now()) - totalPausedMsRef.current);

        clearVoiceNoteRecorder();

        if (durationMs === 0 || blob.size === 0) {
          setVoiceNoteError('Voice note is empty');
          return;
        }

        setIsSendingVoiceNote(true);
        onSendVoiceNote(blob, durationMs, mimeType)
          .then(() => setVoiceNoteError(null))
          .catch(() => setVoiceNoteError('Failed to send voice note'))
          .finally(() => setIsSendingVoiceNote(false));
      };

      recorder.onerror = () => {
        setVoiceNoteError('Voice note recording failed');
        clearVoiceNoteRecorder();
      };

      recorder.start(VOICE_NOTE_TIMESLICE_MS);
      setIsRecordingNote(true);
      setRecordingDuration(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          const next = prev + 1;
          const remainingS = (VOICE_NOTE_MAX_DURATION_MS / 1000) - next;
          if (remainingS <= VOICE_NOTE_DURATION_WARNING_THRESHOLD_S && remainingS > 0) {
            setVoiceNoteTimeWarningSeconds(remainingS);
          } else {
            setVoiceNoteTimeWarningSeconds(null);
          }
          return next;
        });
      }, 1000);
      voiceNoteAutoStopRef.current = setTimeout(() => {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== 'inactive') {
          if (rec.state === 'paused') rec.resume();
          rec.stop();
        }
      }, VOICE_NOTE_MAX_DURATION_MS);
    } catch {
      setVoiceNoteError('Microphone permission denied');
      clearVoiceNoteRecorder();
    }
  }, [clearVoiceNoteRecorder, onSendVoiceNote, isRecordingNote, isSendingVoiceNote]);

  const stopVoiceNoteRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    // If paused, resume before stopping to flush final data
    if (recorder.state === 'paused') {
      // Accumulate paused time before resuming
      if (pauseStartedAtRef.current !== null) {
        totalPausedMsRef.current += Date.now() - pauseStartedAtRef.current;
        pauseStartedAtRef.current = null;
      }
      recorder.resume();
    }
    recorder.stop();
  }, []);

  const togglePauseRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    if (recorder.state === 'recording') {
      // Pause
      recorder.pause();
      pauseStartedAtRef.current = Date.now();
      // Save remaining auto-stop time
      if (voiceNoteAutoStopRef.current) {
        clearTimeout(voiceNoteAutoStopRef.current);
        voiceNoteAutoStopRef.current = null;
      }
      // Freeze the interval timer
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }

      // Compute waveform and preview URL from recorded chunks so far
      const mimeType = recorder.mimeType || 'audio/webm';
      const blob = new Blob(voiceNoteChunksRef.current, { type: mimeType });
      const durationMs = Math.max(0, Date.now() - (voiceNoteStartedAtRef.current ?? Date.now()) - totalPausedMsRef.current);

      const waveform = await computeWaveform(blob);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setPreviewDurationMs(durationMs);
      setPreviewWaveform(waveform);

      setIsRecordingPaused(true);
    } else if (recorder.state === 'paused') {
      // Resume — clear preview state
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setPreviewDurationMs(0);
      setPreviewWaveform([]);

      if (pauseStartedAtRef.current !== null) {
        totalPausedMsRef.current += Date.now() - pauseStartedAtRef.current;
        pauseStartedAtRef.current = null;
      }
      recorder.resume();
      // Restart interval timer
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => {
          const next = prev + 1;
          const remainingS = (VOICE_NOTE_MAX_DURATION_MS / 1000) - next;
          if (remainingS <= VOICE_NOTE_DURATION_WARNING_THRESHOLD_S && remainingS > 0) {
            setVoiceNoteTimeWarningSeconds(remainingS);
          } else {
            setVoiceNoteTimeWarningSeconds(null);
          }
          return next;
        });
      }, 1000);
      // Recalculate auto-stop from remaining recording time
      const elapsedRecordingMs = Date.now() - (voiceNoteStartedAtRef.current ?? Date.now()) - totalPausedMsRef.current;
      const remainingMs = Math.max(0, VOICE_NOTE_MAX_DURATION_MS - elapsedRecordingMs);
      voiceNoteAutoStopRef.current = setTimeout(() => {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== 'inactive') {
          if (rec.state === 'paused') rec.resume();
          rec.stop();
        }
      }, remainingMs);
      setIsRecordingPaused(false);
    }
  }, [previewUrl]);

  const cancelVoiceNoteRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state === 'paused') recorder.resume();
      recorder.stop();
    }
    clearVoiceNoteRecorder();
    setVoiceNoteError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewDurationMs(0);
    setPreviewWaveform([]);
  }, [clearVoiceNoteRecorder, previewUrl]);

  const clearSafeWordDebounce = useCallback(() => {
    if (safeWordDebounceRef.current) {
      clearTimeout(safeWordDebounceRef.current);
      safeWordDebounceRef.current = null;
    }
  }, []);

  const applySafeWord = useCallback(async (word: string) => {
    if (!onUpdateRoomSettings) return;
    setApplyingSafeWord(true);
    setSettingsError(null);
    try {
      const safeWord = await createSafeWordSettings(word);
      onUpdateRoomSettings({
        usernameModeEnabled: pendingUsernameMode,
        safeWord,
      });
      setPendingSafeWord('');
      setSafeWordApplied(true);
      if (safeWordAppliedRef.current) clearTimeout(safeWordAppliedRef.current);
      safeWordAppliedRef.current = setTimeout(() => setSafeWordApplied(false), 2000);
    } catch {
      setSettingsError('Failed to apply safe word.');
    } finally {
      setApplyingSafeWord(false);
    }
  }, [onUpdateRoomSettings, pendingUsernameMode]);

  const debounceSafeWord = useCallback((word: string) => {
    clearSafeWordDebounce();
    safeWordDebounceRef.current = setTimeout(() => {
      const trimmed = word.trim();
      if (!trimmed || !pendingSafeWordEnabled) return;
      void applySafeWord(trimmed);
    }, 800);
  }, [applySafeWord, clearSafeWordDebounce, pendingSafeWordEnabled]);

  const toggleUsernameMode = useCallback(() => {
    const next = !pendingUsernameMode;
    setPendingUsernameMode(next);
    onUpdateRoomSettings?.({
      usernameModeEnabled: next,
      safeWord: roomSettings.safeWord,
    });
  }, [onUpdateRoomSettings, pendingUsernameMode, roomSettings.safeWord]);

  const toggleSafeWord = useCallback(() => {
    const next = !pendingSafeWordEnabled;
    setPendingSafeWordEnabled(next);
    setSettingsError(null);
    setSafeWordApplied(false);
    if (!next) {
      clearSafeWordDebounce();
      setPendingSafeWord('');
      onUpdateRoomSettings?.({
        usernameModeEnabled: pendingUsernameMode,
        safeWord: null,
      });
    } else if (roomSettings.safeWord) {
      onUpdateRoomSettings?.({
        usernameModeEnabled: pendingUsernameMode,
        safeWord: roomSettings.safeWord,
      });
    }
  }, [clearSafeWordDebounce, onUpdateRoomSettings, pendingSafeWordEnabled, pendingUsernameMode, roomSettings.safeWord]);

  const handleSafeWordInput = useCallback((value: string) => {
    setPendingSafeWord(value);
    setSafeWordApplied(false);
    debounceSafeWord(value);
  }, [debounceSafeWord]);

  const flushPendingSafeWord = useCallback(() => {
    clearSafeWordDebounce();
    const trimmed = pendingSafeWord.trim();
    if (trimmed && pendingSafeWordEnabled) {
      void applySafeWord(trimmed);
    }
  }, [applySafeWord, clearSafeWordDebounce, pendingSafeWord, pendingSafeWordEnabled]);

  const submitUsername = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (usernameBusy) return;
    const trimmed = pendingUsername.trim().slice(0, USERNAME_MAX_LENGTH);
    if (!trimmed) {
      setUsernameError('Username is required.');
      return;
    }
    setUsernameBusy(true);
    setUsernameError(null);
    try {
      await onSetLocalUsername(trimmed);
    } catch {
      setUsernameError('Failed to set username.');
    } finally {
      setUsernameBusy(false);
    }
  }, [onSetLocalUsername, pendingUsername, usernameBusy]);

  if (phase === 'creating' || phase === 'connecting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.centered}>
          <p className={styles.status}>Setting up encrypted connection...</p>
        </div>
      </div>
    );
  }

  if (phase === 'waiting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.centered}>
          <p className={styles.status}>Waiting for partner...</p>
          {inviteUrl && (
            <>
              <p className={styles.inviteLabel}>
                Share this link with your partner:
              </p>
              <div className={styles.inviteRow}>
                <div
                  className={`${styles.inviteBox} ${copied ? styles.inviteBoxCopied : ''}`}
                  onClick={handleCopy}
                  role='button'
                  tabIndex={0}
                >
                  <code className={styles.urlText}>{inviteUrl}</code>
                  <div className={styles.inviteActions}>
                    <button
                      type='button'
                      className={styles.copyIcon}
                      onClick={handleCopy}
                      title={copied ? 'copied' : 'copy to clipboard'}
                    >
                      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    </button>
                    {onUpdateRoomSettings && (
                      <button
                        type='button'
                        className={`${styles.gearButton} ${settingsOpen ? styles.gearButtonActive : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSettingsOpen((prev) => {
                            if (prev) flushPendingSafeWord();
                            return !prev;
                          });
                        }}
                        title='Chat room settings'
                      >
                        <IconGear size={21} />
                      </button>
                    )}
                  </div>
                  {copied && (
                    <span
                      className={`${styles.copiedHint} ${copyState === 'fading' ? styles.copiedHintFading : ''}`}
                    >
                      copied to clipboard
                    </span>
                  )}
                </div>
                <QrCode url={inviteUrl} />
              </div>
            </>
          )}
          {onUpdateRoomSettings && (
            <div className={styles.settingsSection}>
              {!settingsOpen && (roomSettings.safeWord || roomSettings.usernameModeEnabled) && (
                <div className={styles.activeSettings}>
                  {roomSettings.safeWord && (
                    <span className={styles.activeSettingTag}>Safe word agreement</span>
                  )}
                  {roomSettings.usernameModeEnabled && (
                    <span className={styles.activeSettingTag}>Username mode</span>
                  )}
                </div>
              )}
              {settingsOpen && (
                <div className={styles.settingsPanel}>
                  <div className={styles.settingsRow}>
                    <label className={styles.settingsLabel}>Safe word agreement</label>
                    <OnOffToggle
                      enabled={pendingSafeWordEnabled}
                      onToggle={toggleSafeWord}
                    />
                  </div>
                  {pendingSafeWordEnabled && (
                    <>
                      <input
                        type='password'
                        className={styles.settingsInput}
                        value={pendingSafeWord}
                        onChange={(event) => handleSafeWordInput(event.target.value)}
                        placeholder={roomSettings.safeWord ? 'Keep existing safe word' : 'Enter safe word'}
                      />
                      {applyingSafeWord && (
                        <p className={styles.settingsHint}>Applying...</p>
                      )}
                      {safeWordApplied && !applyingSafeWord && (
                        <p className={styles.settingsHintSuccess}>Safe word set</p>
                      )}
                    </>
                  )}
                  <div className={styles.settingsRow}>
                    <label className={styles.settingsLabel}>Username mode</label>
                    <OnOffToggle
                      enabled={pendingUsernameMode}
                      onToggle={toggleUsernameMode}
                    />
                  </div>
                  {settingsError && <p className={styles.settingsError}>{settingsError}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'key-exchange') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.centered}>
          <p className={styles.status}>Establishing encrypted channel...</p>
        </div>
      </div>
    );
  }

  if (phase === 'peer-left') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.chatHeader}>
          <StatusBadge phase='peer-left' />
        </div>
        <div className={styles.messageList} role='list' aria-label='Messages'>
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              skipAnimation
              msgId={msg.id}
              kind={msg.kind}
              text={msg.text}
              audioUrl={msg.audioUrl}
              durationMs={msg.durationMs}
              sender={msg.sender}
              displayName={msg.displayName}
              timestamp={msg.timestamp}
              reactions={msg.reactions}
              replyTo={msg.replyTo}
              replyPreview={msg.replyPreview}
              onReplyClick={msg.replyTo ? () => scrollToMessage(msg.replyTo!) : undefined}
              onCopy={msg.kind === 'text' && msg.text ? () => handleCopyMessage(msg.text ?? '') : undefined}
              onDownload={msg.kind === 'audio' && msg.audioUrl ? () => {
                const a = document.createElement('a');
                a.href = msg.audioUrl!;
                a.download = `voice-note-${Date.now()}.webm`;
                a.click();
              } : undefined}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        <ChatInput
          onSend={handleSend}
          onTyping={onTyping}
          disabled={true}
          maxLength={MAX_MESSAGE_LENGTH}
        />
        <div className={styles.restartRow}>
          {newChatButton}
        </div>
      </div>
    );
  }

  if (phase === 'room-closed' || phase === 'expired') {
    const endText = phase === 'expired'
      ? 'This conversation has expired.'
      : 'The conversation has ended.';
    return (
      <div className={styles.wrapper}>
        <div className={styles.centered}>
          <p className={styles.endMessage}>{endText}</p>
          {newChatButton}
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.centered}>
          <p className={styles.errorMessage}>
            {error || 'Something went wrong'}
          </p>
          {newChatButton}
        </div>
      </div>
    );
  }

  const isReady = phase === 'ready';
  const isPeerDisconnected = phase === 'peer-disconnected';
  const connectionQuality = deriveConnectionQuality(phase, messages);

  const effectiveWarningSeconds = voiceNoteSizeWarningSeconds !== null && voiceNoteTimeWarningSeconds !== null
    ? Math.min(voiceNoteSizeWarningSeconds, voiceNoteTimeWarningSeconds)
    : voiceNoteSizeWarningSeconds ?? voiceNoteTimeWarningSeconds;

  // phase === 'ready' or 'peer-disconnected'
  return (
    <div className={styles.wrapper}>
      <InactivityCountdown remainingSeconds={remainingSeconds} />
      <div className={styles.chatHeader}>
        <div className={styles.headerLeft}>
          <StatusBadge phase={isReady ? 'ready' : 'peer-disconnected'} connectionQuality={connectionQuality} />
        </div>
        <div className={styles.headerActions}>
          {showEndForMeOptions ? (
            <div className={styles.confirmBar}>
              <span className={styles.confirmText}>
                How would you like to leave?
              </span>
              <Button
                intent='destructive'
                onClick={() => {
                  setShowEndForMeOptions(false);
                  onEnd();
                }}
              >
                Silent exit
              </Button>
              <Button
                intent='destructive'
                onClick={() => {
                  setShowEndForMeOptions(false);
                  onEndForAll();
                }}
              >
                Notify partner
              </Button>
              <Button
                intent='neutral'
                onClick={() => setShowEndForMeOptions(false)}
              >
                Cancel
              </Button>
            </div>
          ) : showEndConfirm ? (
            <div className={styles.confirmBar}>
              <span className={styles.confirmText}>End for both?</span>
              <Button
                intent='destructive'
                onClick={() => {
                  setShowEndConfirm(false);
                  onEndForAll();
                }}
              >
                Yes
              </Button>
              <Button
                intent='neutral'
                onClick={() => setShowEndConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className={styles.endButtons}>
              <Button
                intent='destructive'
                onClick={() => setShowEndForMeOptions(true)}
                aria-label='End chat for me'
              >
                End for me
              </Button>
              <Button
                intent='destructive'
                onClick={() => setShowEndConfirm(true)}
                aria-label='End chat for everyone'
              >
                End for everyone
              </Button>
            </div>
          )}
          <div className={styles.localSettingsWrapper} ref={localSettingsRef}>
            <button
              type='button'
              className={`${styles.localGearButton} ${localSettingsOpen ? styles.gearButtonActive : ''}`}
              onClick={() => setLocalSettingsOpen(prev => !prev)}
              title='Local settings'
            >
              <IconGear size={21} />
            </button>
            {localSettingsOpen && (
              <div className={styles.localSettingsDropdown}>
                <div className={styles.settingsRow}>
                  <label className={styles.settingsLabel}>Auto-scroll</label>
                  <OnOffToggle
                    enabled={localSettings.autoScroll}
                    onToggle={() => updateSetting('autoScroll', !localSettings.autoScroll)}
                  />
                </div>
                <div className={styles.settingsRow}>
                  <label className={styles.settingsLabel}>Beep sound</label>
                  <OnOffToggle
                    enabled={localSettings.soundEnabled}
                    onToggle={() => updateSetting('soundEnabled', !localSettings.soundEnabled)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {isPeerDisconnected && (
        <div className={styles.reconnectingIndicator}>
          Partner disconnected, waiting for reconnection...
        </div>
      )}
      {isReady && (
        <VoiceControls
          callState={voice.callState}
          isMuted={voice.isMuted}
          callDuration={voice.callDuration}
          privacyAcknowledged={voice.privacyAcknowledged}
          isScreenSharing={voice.isScreenSharing}
          isDeafened={voice.isDeafened}
          isE2eeEnabled={voice.isE2eeEnabled}
          isReconnecting={voice.isReconnecting}
          onStartCall={voice.startCall}
          onAcceptCall={voice.acceptCall}
          onDeclineCall={voice.declineCall}
          onEndCall={voice.endCall}
          onToggleMute={voice.toggleMute}
          onToggleDeafen={voice.toggleDeafen}
          onToggleE2ee={voice.toggleE2ee}
          onAcknowledgePrivacy={voice.acknowledgePrivacy}
          onResetCallState={voice.resetCallState}
          onStartScreenShare={voice.startScreenShare}
          onStopScreenShare={voice.stopScreenShare}
        />
      )}
      {voice.remoteScreenStream && (
        <ScreenShareView stream={voice.remoteScreenStream} />
      )}
      <div
        ref={messageListRef}
        className={styles.messageList}
        role='list'
        aria-label='Messages'
        onScroll={handleMessageListScroll}
      >
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msgId={msg.id}
              kind={msg.kind}
              text={msg.text}
              audioUrl={msg.audioUrl}
              durationMs={msg.durationMs}
              sender={msg.sender}
              displayName={msg.displayName}
              timestamp={msg.timestamp}
              reactions={msg.reactions}
              replyTo={msg.replyTo}
              replyPreview={msg.replyPreview}
              recentEmojis={recentEmojis}
              onReact={isReady ? (emoji) => handleReact(msg.id, emoji) : undefined}
              onReply={isReady ? () => { setReplyingTo(msg); setInputFocusTrigger(c => c + 1); } : undefined}
              onReplyClick={msg.replyTo ? () => scrollToMessage(msg.replyTo!) : undefined}
              onCopy={msg.kind === 'text' && msg.text ? () => handleCopyMessage(msg.text ?? '') : undefined}
              onDownload={msg.kind === 'audio' && msg.audioUrl ? () => {
                const a = document.createElement('a');
                a.href = msg.audioUrl!;
                a.download = `voice-note-${Date.now()}.webm`;
                a.click();
              } : undefined}
            />
          ))}
        {peerTyping && (
          <div
            className={styles.typingIndicator}
            aria-label='Partner is typing'
          >
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
          </div>
        )}
        <div ref={messagesEndRef} />
        {unreadBelow > 0 && (
          <button
            className={styles.newMessagesPill}
            onClick={scrollToBottom}
            type='button'
          >
            &darr; {unreadBelow} new message{unreadBelow > 1 ? 's' : ''}
          </button>
        )}
      </div>
      {replyingTo && (
        <ReplyPreview
          text={replyingTo.kind === 'audio' ? '(voice note)' : (replyingTo.text ?? '')}
          displayName={replyingTo.displayName}
          onCancel={() => setReplyingTo(null)}
        />
      )}
      <ChatInput
        onSend={handleSend}
        onTyping={handleTyping}
        disabled={(usernameModeEnabled && !localUsername) || isPeerDisconnected}
        maxLength={MAX_MESSAGE_LENGTH}
        focusTrigger={inputFocusTrigger}
        isRecording={isRecordingNote}
        isSendingVoiceNote={isSendingVoiceNote}
        recordingDuration={recordingDuration}
        onStartRecording={startVoiceNoteRecording}
        onStopRecording={stopVoiceNoteRecording}
        onCancelRecording={cancelVoiceNoteRecording}
        voiceNoteError={voiceNoteError}
        voiceNoteSizeWarningSeconds={effectiveWarningSeconds}
        isRecordingPaused={isRecordingPaused}
        onTogglePauseRecording={togglePauseRecording}
        previewAudioUrl={previewUrl}
        previewDurationMs={previewDurationMs}
        previewWaveform={previewWaveform}
      />
      {usernameModeEnabled && !localUsername && (
        <div className={styles.usernameModalBackdrop}>
          <form className={styles.usernameModal} onSubmit={submitUsername}>
            <h3 className={styles.usernameTitle}>Choose a username</h3>
            <p className={styles.usernameText}>
              Username mode is enabled for this room. This name will appear next to your messages.
            </p>
            <input
              type='text'
              className={styles.usernameInput}
              value={pendingUsername}
              onChange={(event) => setPendingUsername(event.target.value)}
              maxLength={USERNAME_MAX_LENGTH}
              autoFocus
            />
            {peerUsername && (
              <p className={styles.usernamePeerHint}>Partner username: {peerUsername}</p>
            )}
            {usernameError && <p className={styles.settingsError}>{usernameError}</p>}
            <button className={styles.usernameSave} type='submit' disabled={usernameBusy}>
              {usernameBusy ? 'Saving...' : 'Continue'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
