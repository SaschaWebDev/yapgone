import { useState, useEffect, useRef } from 'react';
import type { CallState } from '@/types';
import { useAudioAnalyser } from '@/hooks';
import { Button } from '../button';
import {
  IconPhone,
  IconMic,
  IconMicOff,
  IconCamera,
  IconScreenShare,
  IconScreenShareOff,
  IconSpeaker,
  IconSpeakerOff,
} from '../icons';
import { AudioWaveform } from './AudioWaveform';
import styles from './VoiceControls.module.css';

type PrivacyAction = 'start' | 'accept';

export function _requiresPrivacyGate(privacyAcknowledged: boolean): boolean {
  return !privacyAcknowledged;
}

interface VoiceControlsProps {
  callState: CallState;
  isMuted: boolean;
  callDuration: number;
  privacyAcknowledged: boolean;
  isScreenSharing: boolean;
  isDeafened: boolean;
  isE2eeEnabled: boolean;
  isReconnecting: boolean;
  e2eeDowngradeRequested: boolean;
  e2eeDowngradeIncoming: boolean;
  onStartCall: () => void;
  onAcceptCall: () => void;
  onDeclineCall: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleE2ee: () => void;
  onAcknowledgePrivacy: () => void;
  onResetCallState: () => void;
  onStartScreenShare: () => void;
  onStopScreenShare: () => void;
  isVideoEnabled: boolean;
  onStartVideo: () => void;
  onStopVideo: () => void;
  onAcceptE2eeDowngrade: () => void;
  onDeclineE2eeDowngrade: () => void;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceControls({
  callState,
  isMuted,
  callDuration,
  privacyAcknowledged,
  isScreenSharing,
  isDeafened,
  isE2eeEnabled: _isE2eeEnabled,
  isReconnecting,
  e2eeDowngradeRequested: _e2eeDowngradeRequested,
  e2eeDowngradeIncoming: _e2eeDowngradeIncoming,
  onStartCall,
  onAcceptCall,
  onDeclineCall,
  onEndCall,
  onToggleMute,
  onToggleDeafen,
  onToggleE2ee: _onToggleE2ee,
  onAcknowledgePrivacy,
  onResetCallState,
  onStartScreenShare,
  onStopScreenShare,
  isVideoEnabled,
  onStartVideo,
  onStopVideo,
  onAcceptE2eeDowngrade: _onAcceptE2eeDowngrade,
  onDeclineE2eeDowngrade: _onDeclineE2eeDowngrade,
  localStream,
  remoteStream,
}: VoiceControlsProps) {
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false);
  const [pendingPrivacyAction, setPendingPrivacyAction] =
    useState<PrivacyAction | null>(null);
  const [ringtoneBlocked, setRingtoneBlocked] = useState(false);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const [dialtoneBlocked, setDialtoneBlocked] = useState(false);
  const dialtoneRef = useRef<HTMLAudioElement | null>(null);
  const declineSfxRef = useRef<HTMLAudioElement | null>(null);
  const prevCallStateRef = useRef<CallState>(callState);

  const { analyserRef: localAnalyserRef, isSpeaking } = useAudioAnalyser(localStream);
  const { analyserRef: remoteAnalyserRef } = useAudioAnalyser(remoteStream);

  useEffect(() => {
    const ringtone = new Audio('/yapgone-ringtone.mp3');
    ringtone.loop = true;
    ringtone.preload = 'auto';
    ringtoneRef.current = ringtone;

    return () => {
      if (ringtoneRef.current) {
        ringtoneRef.current.pause();
        ringtoneRef.current.currentTime = 0;
      }
      ringtoneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const dialtone = new Audio('/yapgone-dialtone.mp3');
    dialtone.loop = true;
    dialtone.preload = 'auto';
    dialtoneRef.current = dialtone;

    return () => {
      if (dialtoneRef.current) {
        dialtoneRef.current.pause();
        dialtoneRef.current.currentTime = 0;
      }
      dialtoneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sfx = new Audio('/yapgone-call-declined.mp3');
    sfx.preload = 'auto';
    declineSfxRef.current = sfx;

    return () => {
      declineSfxRef.current = null;
    };
  }, []);

  useEffect(() => {
    const prev = prevCallStateRef.current;
    prevCallStateRef.current = callState;

    if (prev === 'requesting' && callState === 'ended') {
      void declineSfxRef.current?.play().catch(() => {
        /* autoplay blocked */
      });
    }
  }, [callState]);

  useEffect(() => {
    const ringtone = ringtoneRef.current;
    if (!ringtone) return;

    if (callState === 'ringing') {
      ringtone.currentTime = 0;
      void ringtone
        .play()
        .then(() => {
          setRingtoneBlocked(false);
        })
        .catch(() => {
          // Browser may block autoplay until user interaction.
          setRingtoneBlocked(true);
        });
      return;
    }

    ringtone.pause();
    ringtone.currentTime = 0;
    setRingtoneBlocked(false);
  }, [callState]);

  useEffect(() => {
    const dialtone = dialtoneRef.current;
    if (!dialtone) return;

    if (callState === 'requesting') {
      dialtone.currentTime = 0;
      void dialtone
        .play()
        .then(() => {
          setDialtoneBlocked(false);
        })
        .catch(() => {
          setDialtoneBlocked(true);
        });
      return;
    }

    dialtone.pause();
    dialtone.currentTime = 0;
    setDialtoneBlocked(false);
  }, [callState]);

  const handleEnableRingtone = () => {
    const ringtone = ringtoneRef.current;
    if (!ringtone) return;
    ringtone.currentTime = 0;
    void ringtone
      .play()
      .then(() => {
        setRingtoneBlocked(false);
      })
      .catch(() => {
        setRingtoneBlocked(true);
      });
  };

  const handleEnableDialtone = () => {
    const dialtone = dialtoneRef.current;
    if (!dialtone) return;
    dialtone.currentTime = 0;
    void dialtone
      .play()
      .then(() => {
        setDialtoneBlocked(false);
      })
      .catch(() => {
        setDialtoneBlocked(true);
      });
  };

  // Auto-reset ended/failed state after a brief display
  useEffect(() => {
    if (callState === 'ended' || callState === 'failed') {
      const timer = setTimeout(onResetCallState, 3000);
      return () => clearTimeout(timer);
    }
  }, [callState, onResetCallState]);

  const runPrivacyAction = (action: PrivacyAction) => {
    if (action === 'start') {
      onStartCall();
      return;
    }
    onAcceptCall();
  };

  const handleAcceptCallClick = () => {
    if (_requiresPrivacyGate(privacyAcknowledged)) {
      setShowPrivacyNotice(true);
      setPendingPrivacyAction('accept');
      return;
    }
    onAcceptCall();
  };

  const handlePrivacyAccept = () => {
    const action = pendingPrivacyAction;
    setShowPrivacyNotice(false);
    setPendingPrivacyAction(null);
    onAcknowledgePrivacy();
    if (action) {
      runPrivacyAction(action);
    }
  };

  const handlePrivacyCancel = () => {
    setShowPrivacyNotice(false);
    setPendingPrivacyAction(null);
  };

  useEffect(() => {
    if (pendingPrivacyAction === 'accept' && callState !== 'ringing') {
      setShowPrivacyNotice(false);
      setPendingPrivacyAction(null);
    }
  }, [pendingPrivacyAction, callState]);

  if (showPrivacyNotice) {
    return (
      <div className={styles.privacyNotice}>
        <p className={styles.privacyText}>
          Voice calls connect directly between you and your partner
          (peer-to-peer). This applies whether you start or accept a call. Your
          IP address will be visible to them. Use a VPN if this concerns you.
        </p>
        <div className={styles.privacyActions}>
          <Button intent='neutral' size='sm' onClick={handlePrivacyCancel}>
            Cancel
          </Button>
          <Button intent='positive' size='sm' onClick={handlePrivacyAccept}>
            I understand, continue
          </Button>
        </div>
      </div>
    );
  }

  if (callState === 'idle') {
    return null;
  }

  if (callState === 'requesting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Calling...</span>
          {dialtoneBlocked && (
            <button
              className={styles.enableDialtoneButton}
              onClick={handleEnableDialtone}
              title='Enable dialtone'
              aria-label='Enable dialtone'
            >
              Enable dialtone
            </button>
          )}
          <Button intent='neutral' size='sm' onClick={onEndCall}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (callState === 'ringing') {
    return (
      <div className={styles.wrapper}>
        <div className={`${styles.banner} ${styles.incomingBanner}`}>
          <span className={`${styles.bannerText} ${styles.incomingText}`}>
            Incoming voice call
          </span>
          {ringtoneBlocked && (
            <button
              className={styles.enableRingtoneButton}
              onClick={handleEnableRingtone}
              title='Enable ringtone'
              aria-label='Enable ringtone'
            >
              Enable ringtone
            </button>
          )}
          <button
            className={styles.acceptButton}
            onClick={handleAcceptCallClick}
            title='Accept call'
            aria-label='Accept call'
          >
            <IconPhone size={21} />
          </button>
          <button
            className={styles.declineButton}
            onClick={onDeclineCall}
            title='Decline call'
            aria-label='Decline call'
          >
            <IconPhone size={21} style={{ transform: 'rotate(135deg)' }} />
          </button>
        </div>
      </div>
    );
  }

  if (callState === 'connecting') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.banner}>
          <span className={styles.bannerText}>Connecting...</span>
          <Button intent='neutral' size='sm' onClick={onEndCall}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (callState === 'active') {
    return (
      <div className={styles.wrapper}>
        <div className={styles.activeDot} />
        <span className={styles.duration}>{formatDuration(callDuration)}</span>
        {isReconnecting && (
          <span className={styles.reconnectingText}>Switching...</span>
        )}
        {/*
          E2EE downgrade UI — hidden because the E2EE toggle is currently
          disabled (see comment below). These banners showed when a peer
          requested to disable encryption. Keep in sync with the toggle if
          it is ever re-enabled.
        */}
        <div className={styles.banner} />
        <button
          className={`${isMuted ? styles.mutedButton : styles.muteButton}${!isMuted && isSpeaking ? ` ${styles.micGlowActive}` : ''}`}
          onClick={onToggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {isMuted ? <IconMicOff size={21} /> : <IconMic size={21} />}
        </button>
        <AudioWaveform analyserRef={localAnalyserRef} muted={isMuted} />
        <button
          className={isDeafened ? styles.deafenedButton : styles.deafenButton}
          onClick={onToggleDeafen}
          title={isDeafened ? 'Undeafen' : 'Deafen'}
          aria-label={isDeafened ? 'Undeafen audio' : 'Deafen audio'}
        >
          {isDeafened ? (
            <IconSpeakerOff size={21} />
          ) : (
            <IconSpeaker size={21} />
          )}
        </button>
        <AudioWaveform analyserRef={remoteAnalyserRef} muted={isDeafened} />
        <button
          className={
            isVideoEnabled
              ? styles.videoActiveButton
              : styles.videoButton
          }
          onClick={isVideoEnabled ? onStopVideo : onStartVideo}
          title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
          aria-label={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          <IconCamera size={21} />
        </button>
        {typeof navigator !== 'undefined' &&
          navigator.mediaDevices &&
          typeof navigator.mediaDevices.getDisplayMedia === 'function' && (
            <button
              className={
                isScreenSharing
                  ? styles.screenShareActiveButton
                  : styles.screenShareButton
              }
              onClick={isScreenSharing ? onStopScreenShare : onStartScreenShare}
              title={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
              aria-label={
                isScreenSharing ? 'Stop sharing screen' : 'Share screen'
              }
            >
              {isScreenSharing ? (
                <IconScreenShareOff size={21} />
              ) : (
                <IconScreenShare size={21} />
              )}
            </button>
          )}
        {/*
          TODO: Decide whether to permanently remove or re-introduce this.
          E2EE toggle button — allows the user to disable end-to-end encryption
          on the voice call for potentially higher audio quality (unencrypted
          WebRTC). Currently hidden because encrypted call quality is good enough
          and exposing a "make less secure" button may confuse users. All
          underlying logic (softReconnect, downgrade handshake, e2ee signals)
          is preserved in use-voice-call.ts.
        */}
        <button
          className={styles.endCallButton}
          onClick={onEndCall}
          title='End call'
          aria-label='End call'
        >
          <IconPhone size={21} style={{ transform: 'rotate(135deg)' }} />
        </button>
      </div>
    );
  }

  if (callState === 'ended') {
    return (
      <div className={styles.wrapper}>
        <span className={styles.endedText}>Call ended</span>
      </div>
    );
  }

  if (callState === 'failed') {
    return (
      <div className={styles.wrapper}>
        <span className={styles.failedText}>Voice unavailable</span>
        <Button intent='neutral' size='sm' onClick={onResetCallState}>
          Dismiss
        </Button>
      </div>
    );
  }

  return null;
}
