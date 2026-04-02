import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type FormEvent,
} from 'react';
import { computeWaveform } from '@/utils';
import { buildIdentityMap } from '@/utils/sender-identity';
import { createNotefadeNote, readNotefadeNote } from '@/api';
import { generateSafeWord, encryptForNotefade, decryptFromNotefade, deriveNotefadeKeyB64, BYOK_DELIMITER } from '@/crypto';
import chatBubbleStyles from '@/components/ui/message-bubble/MessageBubble.module.css';
import {
  useGroupChat,
  useVoiceCall,
  useGroupVoice,
  useNotifications,
  useLocalChatSettings,
  useInactivityTimer,
  useRecentEmojis,
  playSendSound,
  unlockAudio,
} from '@/hooks';
import type { VoiceSignal } from '@/types';
import type {
  ChatMessage,
  GalleryImage,
  MessageReaction,
} from '@/hooks/chat-helpers';
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
  VideoView,
  IconCopy,
  IconCheck,
  IconGear,
  IconPerson,
  IconPhone,
  IconShare,
  OnOffToggle,
  QrCode,
  ReplyPreview,
  InactivityCountdown,
  ImageLightbox,
  PollCreator,
  PhotoComposer,
  NotefadeComposer,
  SafetyNumber,
  ParticipantList,
  GroupVoiceControls,
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
  FILE_MAX_IMAGE_BYTES,
  FILE_MAX_GENERAL_BYTES,
  IMAGE_MIME_TYPES,
} from '@/constants';
import styles from './Chat.module.css';

interface ChatProps {
  roomId: string;
  creatorPubKey: string;
  roomSettings: RoomSettings | null;
}

export function Chat({ roomId, creatorPubKey, roomSettings }: ChatProps) {
  const normalizedSettings = normalizeRoomSettings(
    roomSettings ?? DEFAULT_ROOM_SETTINGS,
  );
  const isCreator =
    sessionStorage.getItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`) === '1';
  const [safeWordPassed, setSafeWordPassed] = useState(false);

  if (isCreator) {
    return (
      <CreatorChat roomId={roomId} initialRoomSettings={normalizedSettings} />
    );
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
    sessionStorage.getItem(`${STORAGE_KEYS.SAFEWORD_LOCK_PREFIX}${roomId}`) ===
      '1',
  );
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const remaining = Math.max(0, SAFE_WORD_MAX_ATTEMPTS - attempts);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
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
        sessionStorage.setItem(
          `${STORAGE_KEYS.SAFEWORD_LOCK_PREFIX}${roomId}`,
          '1',
        );
        setBlocked(true);
      }
    },
    [
      attempts,
      blocked,
      checking,
      onPassed,
      roomId,
      roomSettings.safeWord,
      value,
    ],
  );

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
          <p className={styles.safeWordRemaining}>
            Remaining attempts: {remaining}
          </p>
        )}
        {error && <p className={styles.errorMessage}>{error}</p>}
      </div>
    </div>
  );
}

function CreatorChat({
  roomId,
  initialRoomSettings,
}: {
  roomId: string;
  initialRoomSettings: RoomSettings;
}) {
  const voiceHandlerRef = useRef<((signal: VoiceSignal, senderId: string) => void) | null>(null);
  const groupVoiceHandlerRef = useRef<((signal: { kind: string; key?: string }, senderId: string) => void) | null>(null);
  const {
    phase,
    messages,
    peerTyping,
    inviteUrl,
    sendMessage,
    sendNotefade,
    sendNotefadeChat,
    sendNotefadeChatRevealed,
    sendNotefadeChatDestroyed,
    sendReaction,
    removeTimedMessage,
    sendTimedConsumed,
    sendPoll,
    sendPollVote,
    sendGallery,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    sendFile,
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
    participantCount,
    myClientId,
    peerUsernames,
    myPubKeyRaw,
    peerPubKeys,
    sendGroupVoiceSignal,
    sendDirectEncrypted,
    sendBinaryFrame,
    setOnBinaryMessage,
  } = useGroupChat(
    roomId,
    'creator',
    undefined,
    voiceHandlerRef,
    groupVoiceHandlerRef,
    initialRoomSettings,
  );

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
    mediaKeyRaw,
    myClientId,
  });

  const groupVoice = useGroupVoice({
    myClientId,
    peerIds: [...peerPubKeys.keys()],
    sendGroupVoiceSignal,
    sendDirectEncrypted,
    sendBinaryFrame,
    setOnBinaryMessage,
    groupVoiceHandlerRef,
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
      onRemoveTimedMessage={removeTimedMessage}
      onSendTimedConsumed={sendTimedConsumed}
      onTyping={sendTyping}
      onSendVoiceNote={sendVoiceNote}
      onSendFile={sendFile}
      onSendPoll={sendPoll}
      onPollVote={sendPollVote}
      onSendGallery={sendGallery}
      onSendNotefade={sendNotefade}
      onSendNotefadeChat={sendNotefadeChat}
      onSendNotefadeChatRevealed={sendNotefadeChatRevealed}
      onSendNotefadeChatDestroyed={sendNotefadeChatDestroyed}
      roomId={roomId}
      onEnd={endChat}
      onEndForAll={endChatForAll}
      roomSettings={roomSettings}
      onUpdateRoomSettings={updateRoomSettings}
      usernameModeEnabled={usernameModeEnabled}
      localUsername={localUsername}
      peerUsername={peerUsername}
      onSetLocalUsername={setLocalUsername}
      voice={voice}
      groupVoice={groupVoice}
      participantCount={participantCount}
      myClientId={myClientId}
      peerUsernames={peerUsernames}
      myPubKeyRaw={myPubKeyRaw}
      peerPubKeys={peerPubKeys}
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
  const voiceHandlerRef = useRef<((signal: VoiceSignal, senderId: string) => void) | null>(null);
  const groupVoiceHandlerRef = useRef<((signal: { kind: string; key?: string }, senderId: string) => void) | null>(null);
  const {
    phase,
    messages,
    peerTyping,
    sendMessage,
    sendNotefade,
    sendNotefadeChat,
    sendNotefadeChatRevealed,
    sendNotefadeChatDestroyed,
    sendReaction,
    removeTimedMessage,
    sendTimedConsumed,
    sendPoll,
    sendPollVote,
    sendGallery,
    sendTyping,
    sendVoiceSignal,
    sendVoiceNote,
    sendFile,
    endChat,
    endChatForAll,
    roomSettings,
    usernameModeEnabled,
    localUsername,
    peerUsername,
    setLocalUsername,
    mediaKeyRaw,
    error,
    participantCount,
    myClientId,
    peerUsernames,
    myPubKeyRaw,
    peerPubKeys,
    sendGroupVoiceSignal,
    sendDirectEncrypted,
    sendBinaryFrame,
    setOnBinaryMessage,
  } = useGroupChat(
    roomId,
    'joiner',
    creatorPubKey,
    voiceHandlerRef,
    groupVoiceHandlerRef,
    initialRoomSettings,
  );

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
    mediaKeyRaw,
    myClientId,
  });

  const groupVoice = useGroupVoice({
    myClientId,
    peerIds: [...peerPubKeys.keys()],
    sendGroupVoiceSignal,
    sendDirectEncrypted,
    sendBinaryFrame,
    setOnBinaryMessage,
    groupVoiceHandlerRef,
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
      onRemoveTimedMessage={removeTimedMessage}
      onSendTimedConsumed={sendTimedConsumed}
      onTyping={sendTyping}
      onSendVoiceNote={sendVoiceNote}
      onSendFile={sendFile}
      onSendPoll={sendPoll}
      onPollVote={sendPollVote}
      onSendGallery={sendGallery}
      onSendNotefade={sendNotefade}
      onSendNotefadeChat={sendNotefadeChat}
      onSendNotefadeChatRevealed={sendNotefadeChatRevealed}
      onSendNotefadeChatDestroyed={sendNotefadeChatDestroyed}
      roomId={roomId}
      onEnd={endChat}
      onEndForAll={endChatForAll}
      roomSettings={roomSettings}
      onUpdateRoomSettings={undefined}
      usernameModeEnabled={usernameModeEnabled}
      localUsername={localUsername}
      peerUsername={peerUsername}
      onSetLocalUsername={setLocalUsername}
      voice={voice}
      groupVoice={groupVoice}
      participantCount={participantCount}
      myClientId={myClientId}
      peerUsernames={peerUsernames}
      myPubKeyRaw={myPubKeyRaw}
      peerPubKeys={peerPubKeys}
    />
  );
}

function deriveConnectionQuality(
  phase: string,
  msgs: ChatMessage[],
): ConnectionQuality {
  if (phase === 'peer-disconnected') return 'degraded';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg?.sender !== 'system') continue;
    if (msg.text === 'Connection lost, reconnecting...') return 'reconnecting';
    if (msg.text === 'Failed to reconnect') return 'lost';
    break;
  }
  return 'good';
}

// computeWaveform extracted to @/utils/compute-waveform

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
  e2eeDowngradeRequested: boolean;
  e2eeDowngradeIncoming: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startCall: (targetPeerId?: string) => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleE2ee: () => void;
  acceptE2eeDowngrade: () => void;
  declineE2eeDowngrade: () => void;
  acknowledgePrivacy: () => void;
  resetCallState: () => void;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  isVideoEnabled: boolean;
  localVideoStream: MediaStream | null;
  remoteVideoStream: MediaStream | null;
  startVideo: () => Promise<void>;
  stopVideo: () => void;
}

interface ChatViewProps {
  phase: string;
  messages: ChatMessage[];
  peerTyping: boolean;
  inviteUrl: string | null;
  error: string | null;
  onSend: (text: string, replyTo?: string, timed?: boolean) => void;
  onReact: (msgId: string, emoji: string, action: 'add' | 'remove') => void;
  onRemoveTimedMessage: (msgId: string) => void;
  onTyping: (active: boolean) => void;
  onSendVoiceNote: (
    blob: Blob,
    durationMs: number,
    mimeType: string,
    timed?: boolean,
  ) => Promise<void>;
  onSendFile: (file: File, timed?: boolean) => Promise<void>;
  onSendTimedConsumed: (noteId: string) => Promise<void>;
  onSendPoll: (
    question: string,
    questionEmoji: string,
    options: Array<{ text: string; emoji: string }>,
    allowMultiple: boolean,
  ) => Promise<void>;
  onPollVote: (pollId: string, optionIndices: number[]) => Promise<void>;
  onSendGallery: (
    files: File[],
    caption?: string,
    timed?: boolean,
  ) => Promise<void>;
  onSendNotefade: (url: string) => Promise<void>;
  onSendNotefadeChat: (url: string) => Promise<void>;
  onSendNotefadeChatRevealed: (noteId: string) => Promise<void>;
  onSendNotefadeChatDestroyed: (noteId: string) => Promise<void>;
  roomId: string;
  onEnd: () => void;
  onEndForAll: () => void;
  roomSettings: RoomSettings;
  onUpdateRoomSettings?: (settings: RoomSettings) => void;
  usernameModeEnabled: boolean;
  localUsername: string | null;
  peerUsername: string | null;
  onSetLocalUsername: (username: string) => Promise<void>;
  voice: VoiceState;
  groupVoice?: {
    isInGroupVoice: boolean;
    isMuted: boolean;
    voiceParticipants: Set<string>;
    joinGroupVoice: () => Promise<void>;
    leaveGroupVoice: () => Promise<void>;
    toggleMute: () => void;
  };
  participantCount: number;
  myClientId: string | null;
  peerUsernames: Map<string, string | null>;
  myPubKeyRaw: Uint8Array | null;
  peerPubKeys: Map<string, Uint8Array>;
}

function ChatView({
  phase,
  messages,
  peerTyping,
  inviteUrl,
  error,
  onSend,
  onReact,
  onRemoveTimedMessage,
  onTyping,
  onSendVoiceNote,
  onSendFile,
  onSendTimedConsumed,
  onSendPoll,
  onPollVote,
  onSendGallery,
  onSendNotefade,
  onSendNotefadeChat,
  onSendNotefadeChatRevealed,
  onSendNotefadeChatDestroyed,
  roomId,
  onEnd,
  onEndForAll,
  roomSettings,
  onUpdateRoomSettings,
  usernameModeEnabled,
  localUsername,
  peerUsername,
  onSetLocalUsername,
  voice,
  groupVoice,
  participantCount,
  myClientId,
  peerUsernames,
  myPubKeyRaw,
  peerPubKeys,
}: ChatViewProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'shown' | 'fading'>(
    'idle',
  );
  const [isRecordingNote, setIsRecordingNote] = useState(false);
  const [voiceNoteError, setVoiceNoteError] = useState<string | null>(null);
  const [isSendingVoiceNote, setIsSendingVoiceNote] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [voiceNoteSizeWarningSeconds, setVoiceNoteSizeWarningSeconds] =
    useState<number | null>(null);
  const [voiceNoteTimeWarningSeconds, setVoiceNoteTimeWarningSeconds] =
    useState<number | null>(null);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDurationMs, setPreviewDurationMs] = useState(0);
  const [previewWaveform, setPreviewWaveform] = useState<number[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingSafeWordEnabled, setPendingSafeWordEnabled] = useState(
    Boolean(roomSettings.safeWord),
  );
  const [pendingSafeWord, setPendingSafeWord] = useState('');
  const [showSafeWord, setShowSafeWord] = useState(false);
  const [swCopied, setSwCopied] = useState(false);
  const [pendingUsernameMode, setPendingUsernameMode] = useState(
    roomSettings.usernameModeEnabled,
  );
  const [usernameManuallySet, setUsernameManuallySet] = useState(false);
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
  const [fileError, setFileError] = useState<string | null>(null);
  const [autoPlayNextId, setAutoPlayNextId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{
    url: string;
    fileName?: string;
  } | null>(null);
  const [pollCreatorOpen, setPollCreatorOpen] = useState(false);
  const [photoComposerOpen, setPhotoComposerOpen] = useState(false);
  const [cameraFile, setCameraFile] = useState<File | null>(null);
  const [notefadeComposerOpen, setNotefadeComposerOpen] = useState(false);
  const [galleryLightbox, setGalleryLightbox] = useState<{
    images: GalleryImage[];
    index: number;
  } | null>(null);
  const [showParticipantList, setShowParticipantList] = useState(false);
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const [showVoicePrivacyNotice, setShowVoicePrivacyNotice] = useState(false);
  const [pendingMaxParticipants, setPendingMaxParticipants] = useState(
    roomSettings.maxParticipants,
  );
  const isAtBottomRef = useRef(true);
  const timedModeRef = useRef(false);
  const safeWordDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceNoteChunksRef = useRef<Blob[]>([]);
  const voiceNoteStartedAtRef = useRef<number | null>(null);
  const voiceNoteStreamRef = useRef<MediaStream | null>(null);
  const voiceNoteAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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

  const timerPaused =
    phase === 'creating' ||
    phase === 'waiting' ||
    phase === 'connecting' ||
    phase === 'key-exchange';
  const { remainingSeconds, resetTimer } = useInactivityTimer(
    ROOM_INACTIVITY_TTL_MS,
    timerPaused,
  );

  useNotifications(messages, phase, localSettings.soundEnabled);

  const handleHeaderCallClick = () => {
    if (!voice.privacyAcknowledged) {
      setShowVoicePrivacyNotice(true);
      return;
    }
    voice.startCall();
  };

  const handleVoicePrivacyAccept = () => {
    setShowVoicePrivacyNotice(false);
    voice.acknowledgePrivacy();
    voice.startCall();
  };

  const handleVoicePrivacyCancel = () => {
    setShowVoicePrivacyNotice(false);
  };

  const buildParticipantsList = useCallback(() => {
    const list: Array<{
      clientId: string;
      username: string | null;
      isYou: boolean;
    }> = [];
    if (myClientId) {
      list.push({ clientId: myClientId, username: localUsername, isYou: true });
    }
    for (const [id] of peerPubKeys) {
      list.push({ clientId: id, username: peerUsernames.get(id) ?? null, isYou: false });
    }
    return list;
  }, [myClientId, localUsername, peerUsernames, peerPubKeys]);

  const identityMap = useMemo(() => {
    const ids: string[] = [];
    if (myClientId) ids.push(myClientId);
    for (const [id] of peerPubKeys) ids.push(id);
    return buildIdentityMap(ids);
  }, [myClientId, peerPubKeys]);

  const resolveReactorName = useCallback(
    (reaction: MessageReaction): string => {
      if (reaction.fromSelf) return 'You';
      if (reaction.senderId) {
        return peerUsernames.get(reaction.senderId) ?? 'Anonymous';
      }
      return peerUsername ?? 'Anonymous';
    },
    [peerUsernames, peerUsername],
  );

  // Reset inactivity timer on any new message (sent or received)
  useEffect(() => {
    if (messages.length > 0) resetTimer();
  }, [messages.length, resetTimer]);

  // Reset inactivity timer when peer starts typing
  useEffect(() => {
    if (peerTyping) resetTimer();
  }, [peerTyping, resetTimer]);

  // Auto-dismiss voice privacy notice if call state changes
  useEffect(() => {
    if (voice.callState !== 'idle') {
      setShowVoicePrivacyNotice(false);
    }
  }, [voice.callState]);

  // Auto-start video after call connects (triggered by video call button)
  const pendingVideoRef = useRef(false);
  useEffect(() => {
    if (pendingVideoRef.current && voice.callState === 'active') {
      pendingVideoRef.current = false;
      void voice.startVideo();
    }
  }, [voice.callState, voice.startVideo]);

  // Wrap onTyping to also reset inactivity timer
  const handleTyping = useCallback(
    (active: boolean) => {
      if (active) resetTimer();
      onTyping(active);
    },
    [onTyping, resetTimer],
  );

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

  const handleSend = useCallback(
    (text: string) => {
      onSend(text, replyingTo?.id);
      setReplyingTo(null);
      if (localSettings.soundEnabled) playSendSound();
    },
    [onSend, replyingTo, localSettings.soundEnabled],
  );

  const handleSendTimed = useCallback(
    (text: string) => {
      onSend(text, replyingTo?.id, true);
      setReplyingTo(null);
      if (localSettings.soundEnabled) playSendSound();
    },
    [onSend, replyingTo, localSettings.soundEnabled],
  );

  const handleSendPoll = useCallback(
    async (
      question: string,
      questionEmoji: string,
      options: Array<{ text: string; emoji: string }>,
      allowMultiple: boolean,
    ) => {
      await onSendPoll(question, questionEmoji, options, allowMultiple);
      setPollCreatorOpen(false);
      if (localSettings.soundEnabled) playSendSound();
    },
    [onSendPoll, localSettings.soundEnabled],
  );

  const handleSendGallery = useCallback(
    async (files: File[], caption?: string, timed?: boolean) => {
      await onSendGallery(files, caption, timed);
      setPhotoComposerOpen(false);
      setCameraFile(null);
      if (localSettings.soundEnabled) playSendSound();
    },
    [onSendGallery, localSettings.soundEnabled],
  );

  const handleCameraCapture = useCallback((file: File) => {
    setCameraFile(file);
    setPhotoComposerOpen(true);
  }, []);

  const handleNotefadeSend = useCallback(
    async (noteText: string, mode: 'url' | 'chat') => {
      try {
        if (mode === 'url') {
          const encrypted = await encryptForNotefade(noteText, roomId);
          const keyB64 = await deriveNotefadeKeyB64(roomId);
          const url = await createNotefadeNote(encrypted);
          await onSendNotefade(`${url}${BYOK_DELIMITER}${keyB64}`);
        } else {
          const encrypted = await encryptForNotefade(noteText, roomId);
          const url = await createNotefadeNote(encrypted);
          await onSendNotefadeChat(url);
        }
      } catch {
        // silently fail — the note creation failed upstream
      } finally {
        setNotefadeComposerOpen(false);
      }
    },
    [onSendNotefade, onSendNotefadeChat, roomId],
  );

  const [revealedNotes, setRevealedNotes] = useState<Map<string, string>>(
    () => new Map(),
  );

  const handleRevealNotefade = useCallback(
    async (messageId: string, url: string) => {
      try {
        const encryptedText = await readNotefadeNote(url);
        const plaintext = await decryptFromNotefade(encryptedText, roomId);
        setRevealedNotes(prev => new Map(prev).set(messageId, plaintext));
        await onSendNotefadeChatRevealed(messageId);
      } catch (err) {
        const errorText =
          err instanceof Error && err.message.includes('not found')
            ? 'Note expired or already read'
            : 'Failed to reveal note';
        setRevealedNotes(prev =>
          new Map(prev).set(messageId, `[${errorText}]`),
        );
      }
    },
    [roomId, onSendNotefadeChatRevealed],
  );

  const handleDestroyNotefade = useCallback(
    async (messageId: string, url: string) => {
      try {
        await readNotefadeNote(url);
      } catch {
        // note may already be consumed — still mark destroyed
      }
      await onSendNotefadeChatDestroyed(messageId);
    },
    [onSendNotefadeChatDestroyed],
  );

  const handleSendFile = useCallback(
    (file: File) => {
      setFileError(null);
      const maxBytes = IMAGE_MIME_TYPES.has(file.type)
        ? FILE_MAX_IMAGE_BYTES
        : FILE_MAX_GENERAL_BYTES;
      if (file.size === 0) {
        setFileError('File is empty');
        return;
      }
      if (file.size > maxBytes) {
        const limitMB = Math.round(maxBytes / (1024 * 1024));
        setFileError(`File too large (max ${limitMB} MB)`);
        return;
      }
      onSendFile(file)
        .then(() => { if (localSettings.soundEnabled) playSendSound(); })
        .catch(() => setFileError('Failed to send file'));
    },
    [onSendFile, localSettings.soundEnabled],
  );

  const handleGalleryImageClick = useCallback(
    (gallery: GalleryImage[], index: number) => {
      setGalleryLightbox({ images: gallery, index });
    },
    [],
  );

  const handleCopyMessage = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
  }, []);

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

  const handleReact = useCallback(
    (msgId: string, emoji: string) => {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg) return;
      const alreadyReacted = msg.reactions.some(
        (r) => r.emoji === emoji && r.fromSelf,
      );
      trackEmoji(emoji);
      onReact(msgId, emoji, alreadyReacted ? 'remove' : 'add');
    },
    [messages, onReact, trackEmoji],
  );

  const handleTimedExpire = useCallback(
    (msgId: string) => {
      onRemoveTimedMessage(msgId);
    },
    [onRemoveTimedMessage],
  );

  const handlePlayOnceComplete = useCallback(
    (msgId: string) => {
      onSendTimedConsumed(msgId);
    },
    [onSendTimedConsumed],
  );

  const handleAudioEnded = useCallback(
    (msgId: string) => {
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx === -1 || idx >= messages.length - 1) {
        setAutoPlayNextId(null);
        return;
      }
      const next = messages[idx + 1];
      if (next && next.kind === 'audio' && next.audioUrl) {
        setAutoPlayNextId(next.id);
      } else {
        setAutoPlayNextId(null);
      }
    },
    [messages],
  );

  useEffect(() => {
    if (autoPlayNextId && !messages.some((m) => m.id === autoPlayNextId)) {
      setAutoPlayNextId(null);
    }
  }, [messages, autoPlayNextId]);

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
      const newPeerMessages = messages
        .slice(-added)
        .filter((m) => m.sender === 'peer');
      if (newPeerMessages.length > 0) {
        setUnreadBelow((prev) => prev + newPeerMessages.length);
      }
    }
  }, [messages.length, messages, localSettings.autoScroll]);

  // Scroll when typing indicator appears
  useEffect(() => {
    if (!peerTyping) return;
    if (localSettings.autoScroll || isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [peerTyping, localSettings.autoScroll]);

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

  const handleImageLoad = useCallback(() => {
    if (localSettings.autoScroll || isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [localSettings.autoScroll]);

  // Close local settings dropdown on outside click
  useEffect(() => {
    if (!localSettingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        localSettingsRef.current &&
        !localSettingsRef.current.contains(e.target as Node)
      ) {
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
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [localSettingsOpen, replyingTo, showEndConfirm]);

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
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
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

          const elapsedMs =
            Date.now() -
            (voiceNoteStartedAtRef.current ?? Date.now()) -
            totalPausedMsRef.current;
          const elapsedSeconds = elapsedMs / 1000;
          if (elapsedSeconds > 0) {
            const bytesPerSecond = accumulatedBytesRef.current / elapsedSeconds;
            const maxBytes =
              VOICE_NOTE_MAX_BYTES * VOICE_NOTE_SIZE_SAFETY_RATIO;
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
        const durationMs = Math.max(
          0,
          Date.now() -
            (voiceNoteStartedAtRef.current ?? Date.now()) -
            totalPausedMsRef.current,
        );
        const wasTimed = timedModeRef.current;
        timedModeRef.current = false;

        clearVoiceNoteRecorder();

        if (durationMs === 0 || blob.size === 0) {
          setVoiceNoteError('Voice note is empty');
          return;
        }

        setIsSendingVoiceNote(true);
        onSendVoiceNote(blob, durationMs, mimeType, wasTimed || undefined)
          .then(() => {
            setVoiceNoteError(null);
            if (localSettings.soundEnabled) playSendSound();
          })
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
          const remainingS = VOICE_NOTE_MAX_DURATION_MS / 1000 - next;
          if (
            remainingS <= VOICE_NOTE_DURATION_WARNING_THRESHOLD_S &&
            remainingS > 0
          ) {
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
  }, [
    clearVoiceNoteRecorder,
    onSendVoiceNote,
    isRecordingNote,
    isSendingVoiceNote,
  ]);

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

  const stopVoiceNoteRecordingTimed = useCallback(() => {
    timedModeRef.current = true;
    stopVoiceNoteRecording();
  }, [stopVoiceNoteRecording]);

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
      const durationMs = Math.max(
        0,
        Date.now() -
          (voiceNoteStartedAtRef.current ?? Date.now()) -
          totalPausedMsRef.current,
      );

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
          const remainingS = VOICE_NOTE_MAX_DURATION_MS / 1000 - next;
          if (
            remainingS <= VOICE_NOTE_DURATION_WARNING_THRESHOLD_S &&
            remainingS > 0
          ) {
            setVoiceNoteTimeWarningSeconds(remainingS);
          } else {
            setVoiceNoteTimeWarningSeconds(null);
          }
          return next;
        });
      }, 1000);
      // Recalculate auto-stop from remaining recording time
      const elapsedRecordingMs =
        Date.now() -
        (voiceNoteStartedAtRef.current ?? Date.now()) -
        totalPausedMsRef.current;
      const remainingMs = Math.max(
        0,
        VOICE_NOTE_MAX_DURATION_MS - elapsedRecordingMs,
      );
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

  const applySafeWord = useCallback(
    async (word: string) => {
      if (!onUpdateRoomSettings) return;
      setApplyingSafeWord(true);
      setSettingsError(null);
      try {
        const safeWord = await createSafeWordSettings(word);
        onUpdateRoomSettings({
          ...roomSettings,
          usernameModeEnabled: pendingUsernameMode,
          safeWord,
        });
        setSafeWordApplied(true);
        if (safeWordAppliedRef.current)
          clearTimeout(safeWordAppliedRef.current);
        safeWordAppliedRef.current = setTimeout(
          () => setSafeWordApplied(false),
          2000,
        );
      } catch {
        setSettingsError('Failed to apply safe word.');
      } finally {
        setApplyingSafeWord(false);
      }
    },
    [onUpdateRoomSettings, pendingUsernameMode],
  );

  const debounceSafeWord = useCallback(
    (word: string) => {
      clearSafeWordDebounce();
      safeWordDebounceRef.current = setTimeout(() => {
        const trimmed = word.trim();
        if (!trimmed || !pendingSafeWordEnabled) return;
        void applySafeWord(trimmed);
      }, 800);
    },
    [applySafeWord, clearSafeWordDebounce, pendingSafeWordEnabled],
  );

  const usernameForced = pendingMaxParticipants > 2;

  const allSettingsVisible =
    (usernameForced || pendingUsernameMode) && pendingSafeWordEnabled;

  const toggleUsernameMode = useCallback(() => {
    const next = !pendingUsernameMode;
    setPendingUsernameMode(next);
    setUsernameManuallySet(next);
    onUpdateRoomSettings?.({
      ...roomSettings,
      usernameModeEnabled: next,
      safeWord: roomSettings.safeWord,
    });
  }, [onUpdateRoomSettings, pendingUsernameMode, roomSettings]);

  const toggleSafeWord = useCallback(() => {
    const next = !pendingSafeWordEnabled;
    setPendingSafeWordEnabled(next);
    setSettingsError(null);
    setSafeWordApplied(false);
    if (!next) {
      clearSafeWordDebounce();
      setPendingSafeWord('');
      onUpdateRoomSettings?.({
        ...roomSettings,
        usernameModeEnabled: pendingUsernameMode,
        safeWord: null,
      });
    } else if (roomSettings.safeWord) {
      onUpdateRoomSettings?.({
        ...roomSettings,
        usernameModeEnabled: pendingUsernameMode,
        safeWord: roomSettings.safeWord,
      });
    }
  }, [
    clearSafeWordDebounce,
    onUpdateRoomSettings,
    pendingSafeWordEnabled,
    pendingUsernameMode,
    roomSettings.safeWord,
  ]);

  const handleSafeWordInput = useCallback(
    (value: string) => {
      setPendingSafeWord(value);
      setSafeWordApplied(false);
      debounceSafeWord(value);
    },
    [debounceSafeWord],
  );

  const flushPendingSafeWord = useCallback(() => {
    clearSafeWordDebounce();
    const trimmed = pendingSafeWord.trim();
    if (trimmed && pendingSafeWordEnabled) {
      void applySafeWord(trimmed);
    }
  }, [
    applySafeWord,
    clearSafeWordDebounce,
    pendingSafeWord,
    pendingSafeWordEnabled,
  ]);

  const submitUsername = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
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
    },
    [onSetLocalUsername, pendingUsername, usernameBusy],
  );

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
    const handleMaxParticipantsChange = (value: number) => {
      setPendingMaxParticipants(value);
      let nextUsernameMode = pendingUsernameMode;
      if (value > 2 && !pendingUsernameMode) {
        nextUsernameMode = true;
        setPendingUsernameMode(true);
      } else if (value <= 2 && !usernameManuallySet && pendingUsernameMode) {
        nextUsernameMode = false;
        setPendingUsernameMode(false);
      }
      onUpdateRoomSettings?.({
        ...roomSettings,
        maxParticipants: value,
        usernameModeEnabled: nextUsernameMode,
        safeWord: roomSettings.safeWord,
      });
    };

    return (
      <div className={styles.wrapper}>
        <div className={styles.waitingLayout}>
          <div className={styles.shareZone}>
            {inviteUrl && (
              <>
                <p className={styles.inviteLabel}>
                  {pendingMaxParticipants > 2
                    ? `Share this link with up to ${pendingMaxParticipants - 1} others`
                    : 'Share this link with your partner'}
                </p>
                <div className={styles.inviteRow}>
                  <div
                    className={`${styles.inviteBox} ${copied ? styles.inviteBoxCopied : ''}`}
                  >
                    <div
                      className={styles.inviteButtonRow}
                      onClick={handleCopy}
                    >
                      <button
                        type='button'
                        className={styles.copyIcon}
                        onClick={handleCopy}
                        title={copied ? 'copied' : 'copy to clipboard'}
                      >
                        {copied ? (
                          <IconCheck size={16} />
                        ) : (
                          <IconCopy size={16} />
                        )}
                      </button>
                      {typeof navigator.share === 'function' && (
                        <button
                          type='button'
                          className={styles.shareIcon}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.share({ title: 'yapgone', url: inviteUrl }).catch(() => {});
                          }}
                          title='share link'
                        >
                          <IconShare size={16} />
                        </button>
                      )}
                      {copied && (
                        <span
                          className={`${styles.copiedHint} ${copyState === 'fading' ? styles.copiedHintFading : ''}`}
                        >
                          copied to clipboard
                        </span>
                      )}
                    </div>
                    <div
                      className={styles.inviteBoxTop}
                      onClick={handleCopy}
                      role='button'
                      tabIndex={0}
                    >
                      <code className={styles.urlText}>{inviteUrl}</code>
                      <span className={styles.orSeparator}>or</span>
                      <div className={styles.qrSection}>
                        <QrCode url={inviteUrl} />
                      </div>
                    </div>
                    {onUpdateRoomSettings && (
                      <div className={styles.inviteBoxSettings}>
                        <div className={styles.sliderRow}>
                          <div className={styles.participantIcon}>
                            <IconPerson size={40} />
                            <span className={styles.participantCount}>
                              {pendingMaxParticipants}
                            </span>
                          </div>
                          <input
                            type='range'
                            min={2}
                            max={20}
                            value={pendingMaxParticipants}
                            onChange={(e) =>
                              handleMaxParticipantsChange(
                                Number(e.target.value),
                              )
                            }
                            className={styles.participantSlider}
                          />
                          <button
                            type='button'
                            className={`${styles.gearButton} ${
                              allSettingsVisible
                                ? styles.gearButtonDisabled
                                : settingsOpen
                                  ? styles.gearButtonActive
                                  : ''
                            }`}
                            onClick={() => {
                              if (allSettingsVisible) return;
                              setSettingsOpen((prev) => {
                                if (prev) flushPendingSafeWord();
                                return !prev;
                              });
                            }}
                            disabled={allSettingsVisible}
                            title='Chat room settings'
                          >
                            <IconGear size={18} />
                          </button>
                        </div>
                        {(usernameForced ||
                          pendingUsernameMode ||
                          settingsOpen) && (
                          <div
                            className={`${styles.settingsRow} ${styles.settingsRowAnimated}`}
                          >
                            <label className={styles.settingsLabel}>
                              Username mode
                            </label>
                            <OnOffToggle
                              enabled={pendingUsernameMode}
                              onToggle={toggleUsernameMode}
                              disabled={usernameForced}
                            />
                          </div>
                        )}
                        {(pendingSafeWordEnabled || settingsOpen) && (
                          <div
                            className={`${styles.settingsRow} ${styles.settingsRowAnimated}`}
                          >
                            <label className={styles.settingsLabel}>
                              Safe word agreement
                            </label>
                            <OnOffToggle
                              enabled={pendingSafeWordEnabled}
                              onToggle={toggleSafeWord}
                            />
                          </div>
                        )}
                        {pendingSafeWordEnabled && (
                          <>
                            <span
                              className={`${styles.safeWordInputWrapper} ${safeWordApplied && !applyingSafeWord ? styles.safeWordInputWrapperApplied : ''}`}
                            >
                              <input
                                type={showSafeWord ? 'text' : 'password'}
                                className={styles.safeWordInlineInput}
                                value={pendingSafeWord}
                                onChange={(event) =>
                                  handleSafeWordInput(event.target.value)
                                }
                                placeholder={
                                  roomSettings.safeWord
                                    ? 'Keep existing safe word'
                                    : 'Enter safe word'
                                }
                                spellCheck={false}
                                autoComplete='off'
                              />
                              <button
                                type='button'
                                className={`${styles.copySafeWordButton} ${swCopied ? styles.copySafeWordButtonCopied : ''}`}
                                onClick={() => {
                                  if (swCopied) return;
                                  void navigator.clipboard.writeText(
                                    pendingSafeWord,
                                  );
                                  setSwCopied(true);
                                  setTimeout(() => setSwCopied(false), 2000);
                                }}
                                title={swCopied ? 'copied' : 'copy safe word'}
                                tabIndex={-1}
                                disabled={pendingSafeWord.length === 0}
                              >
                                {swCopied ? (
                                  <svg
                                    width='14'
                                    height='14'
                                    viewBox='0 0 14 14'
                                    fill='none'
                                  >
                                    <path
                                      d='M3 7.5L5.5 10L11 4.5'
                                      stroke='#22c55e'
                                      strokeWidth='1.5'
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width='14'
                                    height='14'
                                    viewBox='0 0 14 14'
                                    fill='none'
                                  >
                                    <rect
                                      x='4.5'
                                      y='4.5'
                                      width='7'
                                      height='7'
                                      rx='1.5'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                    />
                                    <path
                                      d='M9.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v5A1.5 1.5 0 003 9.5h1.5'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                    />
                                  </svg>
                                )}
                              </button>
                              <button
                                type='button'
                                className={styles.showSafeWordButton}
                                onClick={() => setShowSafeWord((prev) => !prev)}
                                tabIndex={-1}
                              >
                                {showSafeWord ? (
                                  <svg
                                    width='14'
                                    height='14'
                                    viewBox='0 0 14 14'
                                    fill='none'
                                  >
                                    <path
                                      d='M1.5 7s2.2-3.5 5.5-3.5S12.5 7 12.5 7s-2.2 3.5-5.5 3.5S1.5 7 1.5 7z'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                    />
                                    <circle
                                      cx='7'
                                      cy='7'
                                      r='1.8'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    width='14'
                                    height='14'
                                    viewBox='0 0 14 14'
                                    fill='none'
                                  >
                                    <path
                                      d='M2 2l10 10M5.6 5.7a1.8 1.8 0 002.7 2.6'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                    />
                                    <path
                                      d='M4 4.3C2.7 5.2 1.5 7 1.5 7s2.2 3.5 5.5 3.5c1 0 1.9-.3 2.7-.8M9.5 9.2c1.5-1 2.9-2.7 3-2.7s-2.2-3.5-5.5-3.5c-.6 0-1.2.1-1.7.3'
                                      stroke='currentColor'
                                      strokeWidth='1.2'
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                    />
                                  </svg>
                                )}
                              </button>
                              <button
                                type='button'
                                className={styles.generateSafeWordButton}
                                onClick={() => {
                                  handleSafeWordInput(generateSafeWord());
                                  setShowSafeWord(true);
                                }}
                                title='generate random safe word'
                                tabIndex={-1}
                              >
                                <svg
                                  width='14'
                                  height='14'
                                  viewBox='0 0 14 14'
                                  fill='none'
                                >
                                  <path
                                    d='M2.5 7a4.5 4.5 0 018.3-2.4'
                                    stroke='currentColor'
                                    strokeWidth='1.2'
                                    strokeLinecap='round'
                                  />
                                  <path
                                    d='M11.5 7a4.5 4.5 0 01-8.3 2.4'
                                    stroke='currentColor'
                                    strokeWidth='1.2'
                                    strokeLinecap='round'
                                  />
                                  <path
                                    d='M10.2 2.2l.6 2.4-2.4-.6'
                                    stroke='currentColor'
                                    strokeWidth='1.2'
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                  />
                                  <path
                                    d='M3.8 11.8l-.6-2.4 2.4.6'
                                    stroke='currentColor'
                                    strokeWidth='1.2'
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                  />
                                </svg>
                              </button>
                            </span>
                            {applyingSafeWord && (
                              <p className={styles.settingsHint}>Applying...</p>
                            )}
                            {settingsError && (
                              <p className={styles.settingsError}>
                                {settingsError}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={styles.statusZone}>
            <p className={styles.waitingStatus}>
              {pendingMaxParticipants > 2
                ? 'Waiting for participants'
                : 'Waiting for someone to join'}
              <span className={styles.waitingDot}>.</span>
              <span className={styles.waitingDot}>.</span>
              <span className={styles.waitingDot}>.</span>
            </p>
          </div>
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
              waveform={msg.waveform}
              fileUrl={msg.fileUrl}
              fileName={msg.fileName}
              fileMimeType={msg.fileMimeType}
              fileSize={msg.fileSize}
              transferProgress={msg.transferProgress}
              sender={msg.sender}
              displayName={msg.displayName}
              timestamp={msg.timestamp}
              reactions={msg.reactions}
              replyTo={msg.replyTo}
              replyPreview={msg.replyPreview}
              onReplyClick={
                msg.replyTo ? () => scrollToMessage(msg.replyTo!) : undefined
              }
              onCopy={
                msg.kind === 'text' && msg.text
                  ? () => handleCopyMessage(msg.text ?? '')
                  : msg.kind === 'notefade-chat' && revealedNotes.get(msg.id)
                    ? () => handleCopyMessage(revealedNotes.get(msg.id) ?? '')
                    : undefined
              }
              onDownload={
                (msg.kind === 'audio' && msg.audioUrl) ||
                ((msg.kind === 'image' || msg.kind === 'file') && msg.fileUrl)
                  ? () => {
                      const url = msg.audioUrl ?? msg.fileUrl;
                      if (!url) return;
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = msg.fileName ?? `file-${Date.now()}`;
                      a.click();
                    }
                  : undefined
              }
              autoPlay={autoPlayNextId === msg.id}
              onAudioEnded={
                msg.kind === 'audio' && msg.audioUrl
                  ? handleAudioEnded
                  : undefined
              }
              onImageClick={
                msg.kind === 'image' && msg.fileUrl && !msg.timed
                  ? () =>
                      setLightboxImage({
                        url: msg.fileUrl!,
                        fileName: msg.fileName,
                      })
                  : undefined
              }
              gallery={msg.gallery}
              onGalleryImageClick={
                msg.kind === 'gallery' && msg.gallery
                  ? (index: number) =>
                      handleGalleryImageClick(msg.gallery!, index)
                  : undefined
              }
              notefadeUrl={msg.notefadeUrl}
              notefadeRevealedText={revealedNotes.get(msg.id)}
              notefadeRevealed={msg.notefadeRevealed}
              notefadeDestroyed={msg.notefadeDestroyed}
              onRevealNotefade={handleRevealNotefade}
              onDestroyNotefade={handleDestroyNotefade}
              pollId={msg.pollId}
              pollQuestion={msg.pollQuestion}
              pollEmoji={msg.pollEmoji}
              pollOptions={msg.pollOptions}
              pollAllowMultiple={msg.pollAllowMultiple}
              pollMyVotes={msg.pollMyVotes}
              resolveReactorName={resolveReactorName}
              onImageLoad={handleImageLoad}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        {galleryLightbox && (
          <ImageLightbox
            src={galleryLightbox.images[galleryLightbox.index]?.fileUrl ?? ''}
            fileName={galleryLightbox.images[galleryLightbox.index]?.fileName}
            galleryImages={galleryLightbox.images
              .filter((img): img is GalleryImage & { fileUrl: string } =>
                Boolean(img.fileUrl),
              )
              .map((img) => ({ url: img.fileUrl, fileName: img.fileName }))}
            initialIndex={galleryLightbox.index}
            onClose={() => setGalleryLightbox(null)}
          />
        )}
        {lightboxImage && (
          <ImageLightbox
            src={lightboxImage.url}
            fileName={lightboxImage.fileName}
            onClose={() => setLightboxImage(null)}
            onDownload={() => {
              const a = document.createElement('a');
              a.href = lightboxImage.url;
              a.download = lightboxImage.fileName ?? `image-${Date.now()}`;
              a.click();
            }}
          />
        )}
        <ChatInput
          onSend={handleSend}
          onTyping={onTyping}
          disabled={true}
          maxLength={MAX_MESSAGE_LENGTH}
        />
        <div className={styles.restartRow}>{newChatButton}</div>
      </div>
    );
  }

  if (phase === 'room-closed' || phase === 'expired') {
    const endText =
      phase === 'expired'
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

  const effectiveWarningSeconds =
    voiceNoteSizeWarningSeconds !== null && voiceNoteTimeWarningSeconds !== null
      ? Math.min(voiceNoteSizeWarningSeconds, voiceNoteTimeWarningSeconds)
      : (voiceNoteSizeWarningSeconds ?? voiceNoteTimeWarningSeconds);

  // phase === 'ready' or 'peer-disconnected'
  return (
    <div className={styles.wrapper}>
      <InactivityCountdown remainingSeconds={remainingSeconds} />
      <div className={styles.chatHeader}>
        <div className={styles.headerLeft}>
          <div
            className={styles.securityBox}
            onClick={
              peerPubKeys.size > 0 ? () => setShowSafetyNumber(true) : undefined
            }
            role={peerPubKeys.size > 0 ? 'button' : undefined}
            tabIndex={peerPubKeys.size > 0 ? 0 : undefined}
            title={peerPubKeys.size > 0 ? 'Verify security' : undefined}
            style={peerPubKeys.size === 0 ? { cursor: 'default' } : undefined}
          >
            <span className={`${styles.shieldComposite} ${isReady ? styles.shieldActive : ''}`}>
              <svg
                width='18'
                height='18'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' />
              </svg>
              {!isReady && (
                <span
                  className={`${styles.shieldDot} ${styles.shieldDotWarning}`}
                />
              )}
            </span>
            <span className={styles.securityBadgeLabel}>
              <StatusBadge
                phase={isReady ? 'ready' : 'peer-disconnected'}
                connectionQuality={connectionQuality}
                hideDot
              />
            </span>
          </div>
          {participantCount > 1 && (
            <button
              type='button'
              className={styles.participantBadge}
              onClick={() => setShowParticipantList(true)}
              title='View participants'
            >
              <div className={styles.participantIcon}>
                <IconPerson size={40} />
                <span className={styles.participantCount}>{participantCount}</span>
              </div>
            </button>
          )}
          {isReady && voice.callState === 'idle' && (
            <button
              type='button'
              className={styles.voiceCallBadge}
              onClick={handleHeaderCallClick}
              title='Start voice call'
              aria-label='Start voice call'
            >
              <IconPhone size={20} />
              <span className={styles.voiceCallLabel}>Voice call</span>
            </button>
          )}
        </div>
        <div className={styles.headerActions}>
          {showEndConfirm ? (
            <div className={styles.confirmBarInline}>
              <span className={styles.confirmText}>
                {participantCount > 2 ? 'Leave this chat?' : 'Leave chat?'}
              </span>
              {participantCount > 2 && (
                <Button
                  intent='destructive'
                  onClick={() => {
                    setShowEndConfirm(false);
                    onEnd();
                  }}
                >
                  Leave
                </Button>
              )}
              <Button
                intent='destructive'
                onClick={() => {
                  setShowEndConfirm(false);
                  onEndForAll();
                }}
              >
                {participantCount > 2 ? 'Close room' : 'Leave'}
              </Button>
              <Button intent='neutral' onClick={() => setShowEndConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className={styles.endButtons}>
              <Button
                intent='destructive'
                onClick={participantCount <= 1 ? onEndForAll : () => setShowEndConfirm(true)}
                aria-label='Leave chat'
              >
                Leave
              </Button>
            </div>
          )}
          <div className={styles.localSettingsWrapper} ref={localSettingsRef}>
            <button
              type='button'
              className={`${styles.localGearButton} ${localSettingsOpen ? styles.gearButtonActive : ''}`}
              onClick={() => setLocalSettingsOpen((prev) => !prev)}
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
                    onToggle={() =>
                      updateSetting('autoScroll', !localSettings.autoScroll)
                    }
                  />
                </div>
                <div className={styles.settingsRow}>
                  <label className={styles.settingsLabel}>Message sound</label>
                  <OnOffToggle
                    enabled={localSettings.soundEnabled}
                    onToggle={() => {
                      const willEnable = !localSettings.soundEnabled;
                      updateSetting('soundEnabled', willEnable);
                      if (willEnable) {
                        unlockAudio();
                        playSendSound();
                      }
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {showEndConfirm && (
        <div className={styles.confirmBarMobile}>
          <span className={styles.confirmText}>
            {participantCount > 2 ? 'Leave this chat?' : 'Leave chat?'}
          </span>
          <p className={styles.confirmDescription}>
            This will end the conversation for everyone. All messages and shared files will be permanently deleted and cannot be recovered.
          </p>
          <Button intent='neutral' onClick={() => setShowEndConfirm(false)}>
            Cancel
          </Button>
          {participantCount > 2 && (
            <Button
              intent='destructive'
              onClick={() => {
                setShowEndConfirm(false);
                onEnd();
              }}
            >
              Leave
            </Button>
          )}
          <Button
            intent='destructive'
            onClick={() => {
              setShowEndConfirm(false);
              onEndForAll();
            }}
          >
            {participantCount > 2 ? 'Close room' : 'Leave'}
          </Button>
        </div>
      )}
      {isPeerDisconnected && (
        <div className={styles.reconnectingIndicator}>
          Partner disconnected, waiting for reconnection...
        </div>
      )}
      {showVoicePrivacyNotice && (
        <div className={styles.voicePrivacyBanner}>
          <p className={styles.voicePrivacyText}>
            Voice calls connect directly between you and your partner
            (peer-to-peer). This applies whether you start or accept a call. Your
            IP address will be visible to them. Use a VPN if this concerns you.
          </p>
          <div className={styles.voicePrivacyActions}>
            <Button intent='neutral' size='sm' onClick={handleVoicePrivacyCancel}>
              Cancel
            </Button>
            <Button intent='positive' size='sm' onClick={handleVoicePrivacyAccept}>
              I understand, continue
            </Button>
          </div>
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
          e2eeDowngradeRequested={voice.e2eeDowngradeRequested}
          e2eeDowngradeIncoming={voice.e2eeDowngradeIncoming}
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
          isVideoEnabled={voice.isVideoEnabled}
          onStartVideo={voice.startVideo}
          onStopVideo={voice.stopVideo}
          onAcceptE2eeDowngrade={voice.acceptE2eeDowngrade}
          onDeclineE2eeDowngrade={voice.declineE2eeDowngrade}
          localStream={voice.localStream}
          remoteStream={voice.remoteStream}
        />
      )}
      {isReady && groupVoice && participantCount >= 3 && (
        <GroupVoiceControls
          isInGroupVoice={groupVoice.isInGroupVoice}
          isMuted={groupVoice.isMuted}
          voiceParticipants={groupVoice.voiceParticipants}
          onJoin={groupVoice.joinGroupVoice}
          onLeave={groupVoice.leaveGroupVoice}
          onToggleMute={groupVoice.toggleMute}
        />
      )}
      {voice.remoteScreenStream && (
        <ScreenShareView stream={voice.remoteScreenStream} />
      )}
      {voice.remoteVideoStream && (
        <VideoView
          remoteStream={voice.remoteVideoStream}
          localStream={voice.localVideoStream}
        />
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
            waveform={msg.waveform}
            fileUrl={msg.fileUrl}
            fileName={msg.fileName}
            fileMimeType={msg.fileMimeType}
            fileSize={msg.fileSize}
            transferProgress={msg.transferProgress}
            sender={msg.sender}
            displayName={msg.displayName}
            timestamp={msg.timestamp}
            reactions={msg.reactions}
            replyTo={msg.replyTo}
            replyPreview={msg.replyPreview}
            recentEmojis={recentEmojis}
            timed={msg.timed}
            timedConsumed={msg.timedConsumed}
            onTimedExpire={msg.timed ? handleTimedExpire : undefined}
            onPlayOnceComplete={
              msg.timed && msg.kind === 'audio'
                ? handlePlayOnceComplete
                : undefined
            }
            autoPlay={autoPlayNextId === msg.id}
            onAudioEnded={
              msg.kind === 'audio' && msg.audioUrl
                ? handleAudioEnded
                : undefined
            }
            onReact={
              isReady && !msg.timed
                ? (emoji) => handleReact(msg.id, emoji)
                : undefined
            }
            onReply={
              isReady && !msg.timed
                ? () => {
                    setReplyingTo(msg);
                    setInputFocusTrigger((c) => c + 1);
                  }
                : undefined
            }
            onReplyClick={
              msg.replyTo ? () => scrollToMessage(msg.replyTo!) : undefined
            }
            onCopy={
              msg.kind === 'text' && msg.text && !msg.timed
                ? () => handleCopyMessage(msg.text ?? '')
                : msg.kind === 'notefade-chat' && revealedNotes.get(msg.id)
                  ? () => handleCopyMessage(revealedNotes.get(msg.id) ?? '')
                  : undefined
            }
            onDownload={
              (msg.kind === 'audio' &&
                msg.audioUrl &&
                !(msg.timed && msg.sender === 'peer')) ||
              ((msg.kind === 'image' || msg.kind === 'file') &&
                msg.fileUrl &&
                !(msg.timed && msg.sender === 'peer'))
                ? () => {
                    const url = msg.audioUrl ?? msg.fileUrl;
                    if (!url) return;
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = msg.fileName ?? `file-${Date.now()}.webm`;
                    a.click();
                  }
                : undefined
            }
            onImageClick={
              msg.kind === 'image' && msg.fileUrl && !msg.timed
                ? () =>
                    setLightboxImage({
                      url: msg.fileUrl!,
                      fileName: msg.fileName,
                    })
                : undefined
            }
            gallery={msg.gallery}
            onGalleryImageClick={
              msg.kind === 'gallery' && msg.gallery && !msg.timed
                ? (index: number) =>
                    handleGalleryImageClick(msg.gallery!, index)
                : undefined
            }
            pollId={msg.pollId}
            pollQuestion={msg.pollQuestion}
            pollEmoji={msg.pollEmoji}
            pollOptions={msg.pollOptions}
            pollAllowMultiple={msg.pollAllowMultiple}
            pollMyVotes={msg.pollMyVotes}
            notefadeUrl={msg.notefadeUrl}
            notefadeRevealedText={revealedNotes.get(msg.id)}
            notefadeRevealed={msg.notefadeRevealed}
            notefadeDestroyed={msg.notefadeDestroyed}
            onRevealNotefade={handleRevealNotefade}
            onDestroyNotefade={handleDestroyNotefade}
            onPollVote={isReady ? onPollVote : undefined}
            senderColor={msg.senderId ? identityMap.get(msg.senderId)?.color : undefined}
            resolveReactorName={resolveReactorName}
            onImageLoad={handleImageLoad}
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
          text={
            replyingTo.kind === 'audio'
              ? '(voice note)'
              : replyingTo.kind === 'image'
                ? '(image)'
                : replyingTo.kind === 'file'
                  ? `(file: ${replyingTo.fileName ?? 'unknown'})`
                  : replyingTo.kind === 'poll'
                    ? '(poll)'
                    : replyingTo.kind === 'gallery'
                      ? '(photo gallery)'
                      : (replyingTo.text ?? '')
          }
          displayName={replyingTo.displayName}
          onCancel={() => setReplyingTo(null)}
        />
      )}
      <ChatInput
        onSend={handleSend}
        onSendTimed={handleSendTimed}
        onTyping={handleTyping}
        disabled={(usernameModeEnabled && !localUsername) || isPeerDisconnected}
        maxLength={MAX_MESSAGE_LENGTH}
        focusTrigger={inputFocusTrigger}
        isRecording={isRecordingNote}
        isSendingVoiceNote={isSendingVoiceNote}
        recordingDuration={recordingDuration}
        onStartRecording={startVoiceNoteRecording}
        onStopRecording={stopVoiceNoteRecording}
        onStopRecordingTimed={stopVoiceNoteRecordingTimed}
        onCancelRecording={cancelVoiceNoteRecording}
        voiceNoteError={voiceNoteError}
        voiceNoteSizeWarningSeconds={effectiveWarningSeconds}
        isRecordingPaused={isRecordingPaused}
        onTogglePauseRecording={togglePauseRecording}
        previewAudioUrl={previewUrl}
        previewDurationMs={previewDurationMs}
        previewWaveform={previewWaveform}
        onSendFile={handleSendFile}
        fileError={fileError}
        onOpenPollCreator={() => setPollCreatorOpen(true)}
        onOpenPhotoComposer={() => setPhotoComposerOpen(true)}
        onCameraCapture={handleCameraCapture}
        onOpenNotefadeComposer={() => setNotefadeComposerOpen(true)}
        recentEmojis={recentEmojis}
        onTrackEmoji={trackEmoji}
      />
      {pollCreatorOpen && (
        <PollCreator
          onSend={handleSendPoll}
          onClose={() => setPollCreatorOpen(false)}
          recentEmojis={recentEmojis}
          onTrackEmoji={trackEmoji}
        />
      )}
      {photoComposerOpen && (
        <PhotoComposer
          onSend={handleSendGallery}
          onClose={() => {
            setPhotoComposerOpen(false);
            setCameraFile(null);
          }}
          initialFiles={cameraFile ? [cameraFile] : undefined}
          recentEmojis={recentEmojis}
          onTrackEmoji={trackEmoji}
        />
      )}
      {notefadeComposerOpen && (
        <NotefadeComposer
          onSend={handleNotefadeSend}
          onClose={() => setNotefadeComposerOpen(false)}
        />
      )}
      {galleryLightbox && (
        <ImageLightbox
          src={galleryLightbox.images[galleryLightbox.index]?.fileUrl ?? ''}
          fileName={galleryLightbox.images[galleryLightbox.index]?.fileName}
          galleryImages={galleryLightbox.images
            .filter((img): img is GalleryImage & { fileUrl: string } =>
              Boolean(img.fileUrl),
            )
            .map((img) => ({ url: img.fileUrl, fileName: img.fileName }))}
          initialIndex={galleryLightbox.index}
          onClose={() => setGalleryLightbox(null)}
        />
      )}
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.url}
          fileName={lightboxImage.fileName}
          onClose={() => setLightboxImage(null)}
          onDownload={() => {
            const a = document.createElement('a');
            a.href = lightboxImage.url;
            a.download = lightboxImage.fileName ?? `image-${Date.now()}`;
            a.click();
          }}
        />
      )}
      {showParticipantList && myClientId && (
        <ParticipantList
          participants={buildParticipantsList()}
          identityMap={identityMap}
          onClose={() => setShowParticipantList(false)}
          canCall={isReady && voice.callState === 'idle'}
          onCallParticipant={(clientId) => {
            setShowParticipantList(false);
            if (!voice.privacyAcknowledged) {
              setShowVoicePrivacyNotice(true);
              return;
            }
            voice.startCall(clientId);
          }}
          onVideoCallParticipant={(clientId) => {
            setShowParticipantList(false);
            if (!voice.privacyAcknowledged) {
              setShowVoicePrivacyNotice(true);
              return;
            }
            pendingVideoRef.current = true;
            voice.startCall(clientId);
          }}
        />
      )}
      {showSafetyNumber && myPubKeyRaw && peerPubKeys.size > 0 && (
        <SafetyNumber
          myPubKeyRaw={myPubKeyRaw}
          peerPubKeys={[...peerPubKeys.values()]}
          onClose={() => setShowSafetyNumber(false)}
        />
      )}
      {usernameModeEnabled && !localUsername && (
        <div className={styles.usernameModalBackdrop}>
          <form className={styles.usernameModal} onSubmit={submitUsername}>
            <h3 className={styles.usernameTitle}>Choose a username</h3>
            <p className={styles.usernameText}>
              Username mode is enabled for this room. This name will appear next
              to your messages.
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
              <p className={styles.usernamePeerHint}>
                Partner username: {peerUsername}
              </p>
            )}
            {usernameError && (
              <p className={styles.settingsError}>{usernameError}</p>
            )}
            <button
              className={styles.usernameSave}
              type='submit'
              disabled={usernameBusy}
            >
              {usernameBusy ? 'Saving...' : 'Continue'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
