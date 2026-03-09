import { useRef, useEffect, useState, useCallback, type FormEvent } from 'react';
import { useChatAsCreator, useChatAsJoiner, useVoiceCall } from '@/hooks';
import type { VoiceSignal } from '@/types';
import type { ChatMessage } from '@/hooks/use-chat';
import type { RoomSettings } from '@/room-settings';
import {
  DEFAULT_ROOM_SETTINGS,
  createSafeWordSettings,
  normalizeRoomSettings,
  verifySafeWord,
} from '@/room-settings';
import {
  MessageBubble,
  ChatInput,
  StatusBadge,
  VoiceControls,
  IconCopy,
  IconCheck,
  IconGear,
} from '@/components';
import {
  MAX_MESSAGE_LENGTH,
  COPY_FLASH_FADE_MS,
  COPY_FLASH_DONE_MS,
  STORAGE_KEYS,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_MAX_DURATION_MS,
  VOICE_NOTE_SIZE_WARNING_THRESHOLD_S,
  VOICE_NOTE_SIZE_SAFETY_RATIO,
  VOICE_NOTE_TIMESLICE_MS,
  SAFE_WORD_MAX_ATTEMPTS,
  USERNAME_MAX_LENGTH,
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
    error,
  } = useChatAsCreator(voiceHandlerRef, initialRoomSettings);

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
  });

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={inviteUrl}
      error={error}
      onSend={sendMessage}
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
    error,
  } = useChatAsJoiner(roomId, creatorPubKey, initialRoomSettings, voiceHandlerRef);

  const voice = useVoiceCall({
    sendSignal: sendVoiceSignal,
    onSignalRef: voiceHandlerRef,
    peerConnected: phase === 'ready',
  });

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={null}
      error={error}
      onSend={sendMessage}
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

interface VoiceState {
  callState: import('@/types').CallState;
  isMuted: boolean;
  callDuration: number;
  privacyAcknowledged: boolean;
  startCall: () => void;
  acceptCall: () => Promise<void>;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  acknowledgePrivacy: () => void;
  resetCallState: () => void;
}

interface ChatViewProps {
  phase: string;
  messages: ChatMessage[];
  peerTyping: boolean;
  inviteUrl: string | null;
  error: string | null;
  onSend: (text: string) => void;
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
  const [showEndForMeConfirm, setShowEndForMeConfirm] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'shown' | 'fading'>(
    'idle',
  );
  const [isRecordingNote, setIsRecordingNote] = useState(false);
  const [voiceNoteError, setVoiceNoteError] = useState<string | null>(null);
  const [isSendingVoiceNote, setIsSendingVoiceNote] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [voiceNoteSizeWarningSeconds, setVoiceNoteSizeWarningSeconds] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingSafeWordEnabled, setPendingSafeWordEnabled] = useState(Boolean(roomSettings.safeWord));
  const [pendingSafeWord, setPendingSafeWord] = useState('');
  const [pendingUsernameMode, setPendingUsernameMode] = useState(roomSettings.usernameModeEnabled);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [pendingUsername, setPendingUsername] = useState('');
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceNoteChunksRef = useRef<Blob[]>([]);
  const voiceNoteStartedAtRef = useRef<number | null>(null);
  const voiceNoteStreamRef = useRef<MediaStream | null>(null);
  const voiceNoteAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accumulatedBytesRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const copied = copyState !== 'idle';

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

  const newChatButton = (
    <button className={styles.restartLink} onClick={handleNewChat}>
      Start a new conversation
    </button>
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    setPendingSafeWordEnabled(Boolean(roomSettings.safeWord));
    setPendingUsernameMode(roomSettings.usernameModeEnabled);
  }, [roomSettings]);

  useEffect(() => {
    if (localUsername) {
      setPendingUsername(localUsername);
    }
  }, [localUsername]);

  useEffect(() => {
    return () => {
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
    setIsRecordingNote(false);
    setRecordingDuration(0);
    setVoiceNoteSizeWarningSeconds(null);
  }, []);

  const finalizeVoiceNote = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const startedAt = voiceNoteStartedAtRef.current ?? Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    const mimeType = recorder?.mimeType || 'audio/webm';
    const blob = new Blob(voiceNoteChunksRef.current, { type: mimeType });

    clearVoiceNoteRecorder();
    setIsSendingVoiceNote(true);

    if (durationMs === 0 || blob.size === 0) {
      setVoiceNoteError('Voice note is empty');
      setIsSendingVoiceNote(false);
      return;
    }
    onSendVoiceNote(blob, durationMs, mimeType)
      .then(() => setVoiceNoteError(null))
      .catch(() => setVoiceNoteError('Failed to send voice note'))
      .finally(() => setIsSendingVoiceNote(false));
  }, [clearVoiceNoteRecorder, onSendVoiceNote]);

  const startVoiceNoteRecording = useCallback(async () => {
    if (isRecordingNote || isSendingVoiceNote) return;
    setVoiceNoteError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceNoteStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      voiceNoteChunksRef.current = [];
      voiceNoteStartedAtRef.current = Date.now();
      accumulatedBytesRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceNoteChunksRef.current.push(event.data);
          accumulatedBytesRef.current += event.data.size;

          const elapsedMs = Date.now() - (voiceNoteStartedAtRef.current ?? Date.now());
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

      recorder.onstop = finalizeVoiceNote;

      recorder.onerror = () => {
        setVoiceNoteError('Voice note recording failed');
        clearVoiceNoteRecorder();
      };

      recorder.start(VOICE_NOTE_TIMESLICE_MS);
      setIsRecordingNote(true);
      setRecordingDuration(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
      voiceNoteAutoStopRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, VOICE_NOTE_MAX_DURATION_MS);
    } catch {
      setVoiceNoteError('Microphone permission denied');
      clearVoiceNoteRecorder();
    }
  }, [clearVoiceNoteRecorder, finalizeVoiceNote, isRecordingNote, isSendingVoiceNote]);

  const stopVoiceNoteRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.stop();
  }, []);

  const cancelVoiceNoteRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    clearVoiceNoteRecorder();
    setVoiceNoteError(null);
  }, [clearVoiceNoteRecorder]);

  const saveRoomSettings = useCallback(async () => {
    if (!onUpdateRoomSettings || savingSettings) return;
    if (pendingSafeWordEnabled && !roomSettings.safeWord && pendingSafeWord.trim().length === 0) {
      setSettingsError('Safe word is required when enabled.');
      return;
    }
    setSavingSettings(true);
    setSettingsError(null);
    try {
      const nextSafeWord = pendingSafeWordEnabled
        ? (
          roomSettings.safeWord && pendingSafeWord.trim().length === 0
            ? roomSettings.safeWord
            : await createSafeWordSettings(pendingSafeWord.trim())
        )
        : null;

      if (pendingSafeWordEnabled && !nextSafeWord) {
        setSettingsError('Safe word is required when enabled.');
        return;
      }

      onUpdateRoomSettings({
        usernameModeEnabled: pendingUsernameMode,
        safeWord: nextSafeWord,
      });
      setPendingSafeWord('');
      setSettingsOpen(false);
    } catch {
      setSettingsError('Failed to save room settings.');
    } finally {
      setSavingSettings(false);
    }
  }, [
    onUpdateRoomSettings,
    pendingSafeWord,
    pendingSafeWordEnabled,
    pendingUsernameMode,
    roomSettings.safeWord,
    savingSettings,
  ]);

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
            <div className={styles.inviteSection}>
              <p className={styles.inviteLabel}>
                Share this link with your partner:
              </p>
              <div
                className={`${styles.inviteBox} ${copied ? styles.inviteBoxCopied : ''}`}
                onClick={handleCopy}
                role='button'
                tabIndex={0}
              >
                <code className={styles.urlText}>{inviteUrl}</code>
                <button
                  type='button'
                  className={styles.copyIcon}
                  onClick={handleCopy}
                  title={copied ? 'copied' : 'copy to clipboard'}
                >
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </button>
                {copied && (
                  <span
                    className={`${styles.copiedHint} ${copyState === 'fading' ? styles.copiedHintFading : ''}`}
                  >
                    copied to clipboard
                  </span>
                )}
              </div>
            </div>
          )}
          {onUpdateRoomSettings && (
            <div className={styles.settingsSection}>
              <button
                type='button'
                className={`${styles.gearButton} ${settingsOpen ? styles.gearButtonActive : ''}`}
                onClick={() => setSettingsOpen((prev) => !prev)}
                title='Chat room settings'
              >
                <IconGear size={18} />
              </button>
              {settingsOpen && (
                <div className={styles.settingsPanel}>
                  <div className={styles.settingsRow}>
                    <label className={styles.settingsLabel}>Safe word agreement</label>
                    <button
                      type='button'
                      className={styles.settingsToggle}
                      onClick={() => setPendingSafeWordEnabled((prev) => !prev)}
                    >
                      {pendingSafeWordEnabled ? 'On' : 'Off'}
                    </button>
                  </div>
                  {pendingSafeWordEnabled && (
                    <input
                      type='password'
                      className={styles.settingsInput}
                      value={pendingSafeWord}
                      onChange={(event) => setPendingSafeWord(event.target.value)}
                      placeholder={roomSettings.safeWord ? 'Keep existing safe word' : 'Enter safe word'}
                    />
                  )}
                  <div className={styles.settingsRow}>
                    <label className={styles.settingsLabel}>Username mode</label>
                    <button
                      type='button'
                      className={styles.settingsToggle}
                      onClick={() => setPendingUsernameMode((prev) => !prev)}
                    >
                      {pendingUsernameMode ? 'On' : 'Off'}
                    </button>
                  </div>
                  {settingsError && <p className={styles.settingsError}>{settingsError}</p>}
                  <button
                    type='button'
                    className={styles.settingsSave}
                    disabled={savingSettings}
                    onClick={() => void saveRoomSettings()}
                  >
                    {savingSettings ? 'Saving...' : 'Save settings'}
                  </button>
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
              kind={msg.kind}
              text={msg.text}
              audioUrl={msg.audioUrl}
              durationMs={msg.durationMs}
              sender={msg.sender}
              displayName={msg.displayName}
              timestamp={msg.timestamp}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        <ChatInput
          onSend={onSend}
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

  // phase === 'ready'
  return (
    <div className={styles.wrapper}>
      <div className={styles.chatHeader}>
        <StatusBadge phase='ready' />
        {showEndForMeConfirm ? (
          <div className={styles.confirmBar}>
            <span className={styles.confirmText}>
              Your partner will be notified that you left. Continue?
            </span>
            <button
              className={styles.confirmYes}
              onClick={() => {
                setShowEndForMeConfirm(false);
                onEnd();
              }}
            >
              Yes
            </button>
            <button
              className={styles.confirmCancel}
              onClick={() => setShowEndForMeConfirm(false)}
            >
              Cancel
            </button>
          </div>
        ) : showEndConfirm ? (
          <div className={styles.confirmBar}>
            <span className={styles.confirmText}>End for both?</span>
            <button
              className={styles.confirmYes}
              onClick={() => {
                setShowEndConfirm(false);
                onEndForAll();
              }}
            >
              Yes
            </button>
            <button
              className={styles.confirmCancel}
              onClick={() => setShowEndConfirm(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className={styles.endButtons}>
            <button
              className={styles.endButton}
              onClick={() => setShowEndForMeConfirm(true)}
              aria-label='End chat for me'
            >
              End for me
            </button>
            <button
              className={styles.endButton}
              onClick={() => setShowEndConfirm(true)}
              aria-label='End chat for everyone'
            >
              End for everyone
            </button>
          </div>
        )}
      </div>
      <VoiceControls
        callState={voice.callState}
        isMuted={voice.isMuted}
        callDuration={voice.callDuration}
        privacyAcknowledged={voice.privacyAcknowledged}
        onStartCall={voice.startCall}
        onAcceptCall={voice.acceptCall}
        onDeclineCall={voice.declineCall}
        onEndCall={voice.endCall}
        onToggleMute={voice.toggleMute}
        onAcknowledgePrivacy={voice.acknowledgePrivacy}
        onResetCallState={voice.resetCallState}
      />
      <div className={styles.messageList} role='list' aria-label='Messages'>
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              kind={msg.kind}
              text={msg.text}
              audioUrl={msg.audioUrl}
              durationMs={msg.durationMs}
              sender={msg.sender}
              displayName={msg.displayName}
              timestamp={msg.timestamp}
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
      </div>
      <ChatInput
        onSend={onSend}
        onTyping={onTyping}
        disabled={usernameModeEnabled && !localUsername}
        maxLength={MAX_MESSAGE_LENGTH}
        isRecording={isRecordingNote}
        isSendingVoiceNote={isSendingVoiceNote}
        recordingDuration={recordingDuration}
        onStartRecording={startVoiceNoteRecording}
        onStopRecording={stopVoiceNoteRecording}
        onCancelRecording={cancelVoiceNoteRecording}
        voiceNoteError={voiceNoteError}
        voiceNoteSizeWarningSeconds={voiceNoteSizeWarningSeconds}
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
