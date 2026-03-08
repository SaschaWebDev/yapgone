import { useRef, useEffect, useState, useCallback } from 'react';
import { useChatAsCreator, useChatAsJoiner } from '@/hooks';
import {
  MessageBubble,
  ChatInput,
  StatusBadge,
  IconCopy,
  IconCheck,
} from '@/components';
import {
  MAX_MESSAGE_LENGTH,
  COPY_FLASH_FADE_MS,
  COPY_FLASH_DONE_MS,
  STORAGE_KEYS,
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
  const {
    phase,
    messages,
    peerTyping,
    inviteUrl,
    sendMessage,
    sendTyping,
    endChat,
    endChatForAll,
    error,
  } = useChatAsCreator();

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={inviteUrl}
      error={error}
      onSend={sendMessage}
      onTyping={sendTyping}
      onEnd={endChat}
      onEndForAll={endChatForAll}
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
  const {
    phase,
    messages,
    peerTyping,
    sendMessage,
    sendTyping,
    endChat,
    endChatForAll,
    error,
  } = useChatAsJoiner(roomId, creatorPubKey);

  return (
    <ChatView
      phase={phase}
      messages={messages}
      peerTyping={peerTyping}
      inviteUrl={null}
      error={error}
      onSend={sendMessage}
      onTyping={sendTyping}
      onEnd={endChat}
      onEndForAll={endChatForAll}
    />
  );
}

interface ChatViewProps {
  phase: string;
  messages: Array<{
    id: string;
    text: string;
    sender: 'self' | 'peer' | 'system';
    timestamp: number;
  }>;
  peerTyping: boolean;
  inviteUrl: string | null;
  error: string | null;
  onSend: (text: string) => void;
  onTyping: (active: boolean) => void;
  onEnd: () => void;
  onEndForAll: () => void;
}

function ChatView({
  phase,
  messages,
  peerTyping,
  inviteUrl,
  error,
  onSend,
  onTyping,
  onEnd,
  onEndForAll,
}: ChatViewProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showEndForMeConfirm, setShowEndForMeConfirm] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'shown' | 'fading'>(
    'idle',
  );
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
              text={msg.text}
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
      <div className={styles.messageList} role='list' aria-label='Messages'>
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            text={msg.text}
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
      />
    </div>
  );
}
