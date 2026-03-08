import { useRef, useEffect, useState, useCallback } from 'react';
import { useChatAsCreator, useChatAsJoiner, useVoiceCall } from '@/hooks';
import type { VoiceSignal } from '@/types';
import type { ChatMessage } from '@/hooks/use-chat';
import {
  MessageBubble,
  ChatInput,
  StatusBadge,
  VoiceControls,
  IconCopy,
  IconCheck,
} from '@/components';
import {
  MAX_MESSAGE_LENGTH,
  COPY_FLASH_FADE_MS,
  COPY_FLASH_DONE_MS,
  STORAGE_KEYS,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_MAX_DURATION_MS,
} from '@/constants';
import styles from './Chat.module.css';

interface ChatProps {
  roomId: string;
  creatorPubKey: string;
}

export function Chat({ roomId, creatorPubKey }: ChatProps) {
  const isCreator =
    sessionStorage.getItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`) === '1';

  if (isCreator) {
    return <CreatorChat />;
  }
  return <JoinerChat roomId={roomId} creatorPubKey={creatorPubKey} />;
}

function CreatorChat() {
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
    error,
  } = useChatAsCreator(voiceHandlerRef);

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
      voice={voice}
    />
  );
}

function JoinerChat({
  roomId,
  creatorPubKey,
}: {
  roomId: string;
  creatorPubKey: string;
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
    error,
  } = useChatAsJoiner(roomId, creatorPubKey, voiceHandlerRef);

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
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceNoteChunksRef = useRef<Blob[]>([]);
  const voiceNoteStartedAtRef = useRef<number | null>(null);
  const voiceNoteStreamRef = useRef<MediaStream | null>(null);
  const voiceNoteAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setIsRecordingNote(false);
    setRecordingDuration(0);
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
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      voiceNoteChunksRef.current = [];
      voiceNoteStartedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceNoteChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setVoiceNoteError('Voice note recording failed');
        clearVoiceNoteRecorder();
      };

      recorder.start();
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
  }, [clearVoiceNoteRecorder, isRecordingNote, isSendingVoiceNote]);

  const stopVoiceNoteRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    setIsSendingVoiceNote(true);

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const startedAt = voiceNoteStartedAtRef.current ?? Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(voiceNoteChunksRef.current, { type: mimeType });

    clearVoiceNoteRecorder();

    if (durationMs === 0 || blob.size === 0) {
      setVoiceNoteError('Voice note is empty');
      setIsSendingVoiceNote(false);
      return;
    }
    if (blob.size > VOICE_NOTE_MAX_BYTES) {
      setVoiceNoteError('Voice note too large');
      setIsSendingVoiceNote(false);
      return;
    }

    try {
      await onSendVoiceNote(blob, durationMs, mimeType);
      setVoiceNoteError(null);
    } catch {
      setVoiceNoteError('Failed to send voice note');
    } finally {
      setIsSendingVoiceNote(false);
    }
  }, [clearVoiceNoteRecorder, onSendVoiceNote]);

  const cancelVoiceNoteRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    clearVoiceNoteRecorder();
    setVoiceNoteError(null);
  }, [clearVoiceNoteRecorder]);

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
        disabled={false}
        maxLength={MAX_MESSAGE_LENGTH}
        isRecording={isRecordingNote}
        isSendingVoiceNote={isSendingVoiceNote}
        recordingDuration={recordingDuration}
        onStartRecording={startVoiceNoteRecording}
        onStopRecording={stopVoiceNoteRecording}
        onCancelRecording={cancelVoiceNoteRecording}
        voiceNoteError={voiceNoteError}
      />
    </div>
  );
}
