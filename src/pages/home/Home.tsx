import { useState, useCallback, useEffect, useRef } from 'react';
import {
  generateKeyPair,
  exportPublicKey,
  toBase64Url,
  xorSplit,
} from '@/crypto';
import { createRoom, storeShard, buildSplitInviteFragment } from '@/api';
import { STORAGE_KEYS } from '@/constants';
import { DEFAULT_ROOM_SETTINGS } from '@/room-settings';
import { useTheme } from '@/hooks';
import { IconSun, IconMoon } from '@/components/ui/icons';
import styles from './Home.module.css';

const BUILD_HASH = '7a4c·f9e2·6b1d·08af';

function DecryptCipher() {
  const [text, setText] = useState('gone');

  useEffect(() => {
    const target = 'gone';
    const chars = '0123456789abcdef';
    const rand = () => chars[Math.floor(Math.random() * chars.length)];
    let phase: 'hold' | 'scramble' | 'resolve' = 'hold';
    let step = 0;

    const id = window.setInterval(() => {
      if (phase === 'hold') {
        step++;
        if (step > 22) {
          phase = 'scramble';
          step = 0;
        }
      } else if (phase === 'scramble') {
        setText(target.split('').map(rand).join(''));
        step++;
        if (step > 14) {
          phase = 'resolve';
          step = 0;
        }
      } else {
        setText(
          target
            .split('')
            .map((c, i) => (i <= step ? c : rand()))
            .join(''),
        );
        step++;
        if (step >= target.length) {
          phase = 'hold';
          step = 0;
          setText(target);
        }
      }
    }, 70);

    return () => window.clearInterval(id);
  }, []);

  return (
    <span className={styles.decryptWrap}>
      <span className={styles.decrypt}>{text}</span>
      <span className={styles.caret} aria-hidden='true' />
    </span>
  );
}

function parseInvite(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let fragment = trimmed;
  if (trimmed.includes('#')) {
    fragment = trimmed.slice(trimmed.indexOf('#') + 1);
  }
  if (fragment.startsWith('#')) {
    fragment = fragment.slice(1);
  }

  const firstColon = fragment.indexOf(':');
  if (firstColon === -1) return null;
  const roomId = fragment.slice(0, firstColon);
  const rest = fragment.slice(firstColon + 1);
  if (!roomId || !rest) return null;

  return fragment;
}

interface JoinDialogProps {
  onClose: () => void;
}

function JoinDialog({ onClose }: JoinDialogProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    const fragment = parseInvite(value);
    if (!fragment) {
      setError('Paste a yapgone invite URL or fragment.');
      return;
    }
    window.location.hash = fragment;
  };

  return (
    <div
      className={styles.dialogBackdrop}
      onClick={onClose}
      role='presentation'
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role='dialog'
        aria-modal='true'
        aria-labelledby='join-title'
      >
        <h2 id='join-title' className={styles.dialogTitle}>
          Join a room
        </h2>
        <p className={styles.dialogHint}>
          Paste an invite URL someone shared with you. Nothing is stored — we
          read the fragment locally and load the room.
        </p>
        <input
          ref={inputRef}
          className={styles.dialogInput}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder='https://yapgone.app/#…'
          spellCheck={false}
          autoComplete='off'
        />
        {error && <p className={styles.dialogError}>{error}</p>}
        <div className={styles.dialogActions}>
          <button
            type='button'
            className={`${styles.dialogBtn} ${styles.dialogBtnGhost}`}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type='button'
            className={`${styles.dialogBtn} ${styles.dialogBtnPrimary}`}
            onClick={submit}
          >
            Open room
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      className={styles.tickIcon}
      viewBox='0 0 12 12'
      fill='none'
      stroke='#5BD3FF'
      strokeWidth='1.6'
      aria-hidden='true'
    >
      <path d='M2 6.5l2.5 2.5L10 3' />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      aria-hidden='true'
    >
      <path d='M5 12h14M13 6l6 6-6 6' />
    </svg>
  );
}

export function Home() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const handleCreate = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const kp = await generateKeyPair();
      const roomId = await createRoom(DEFAULT_ROOM_SETTINGS.maxParticipants);
      const pubKeyRaw = await exportPublicKey(kp.publicKey);

      const { share1: urlShare, share2: serverShard } = xorSplit(pubKeyRaw);
      const urlShareB64 = toBase64Url(urlShare);
      const serverShardB64 = toBase64Url(serverShard);

      await storeShard(roomId, serverShardB64);

      const fragment = buildSplitInviteFragment(roomId, urlShareB64);

      localStorage.setItem(`${STORAGE_KEYS.CREATOR_PREFIX}${roomId}`, '1');
      window.location.hash = fragment;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room');
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setJoinOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const modKey =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? '⌘ J'
      : 'Ctrl J';

  return (
    <div className={styles.root}>
      <div className={styles.stage} aria-hidden='true'>
        <div className={styles.grid} />
        <div className={styles.gridBright} />
        <div className={styles.beam} />
        <div className={styles.beam2} />
        <div className={styles.vignette} />
      </div>

      <nav className={styles.nav}>
        <div className={styles.brand}>
          <img src='/yapgone-logo.png' alt='' className={styles.brandLogo} />
          <span className={styles.wordmark}>yapgone</span>
          <span className={styles.tagline}>
            encrypted yapping, gone for good
          </span>
        </div>
        <div className={styles.navActions}>
          <div className={styles.pill}>
            <span className={styles.pillDot} />
            relay · online
          </div>
          <button
            type='button'
            className={styles.iconBtn}
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
          </button>
        </div>
      </nav>

      <div className={styles.hero}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowKey}>e2ee</span>
          client-side · zero-knowledge chat
        </div>
        <h1 className={styles.h1}>
          Encrypted yapping,
          <br />
          <DecryptCipher />
          <span> for good.</span>
        </h1>
        <p className={styles.sub}>
          Ephemeral zero-knowledge chat with voice, video, files encrypted in
          your browser. Close the tab and the conversation never existed.
        </p>
        <div className={styles.ctas}>
          <button
            type='button'
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleCreate}
            disabled={loading}
          >
            {loading ? 'Creating…' : 'Start a conversation'}
            <ArrowRightIcon />
          </button>
          <button
            type='button'
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => setJoinOpen(true)}
          >
            Join a room <span className={styles.kbd}>{modKey}</span>
          </button>
        </div>

        <div className={styles.tickRow}>
          <span className={styles.tick}>
            <CheckIcon />
            end to end encrypted
          </span>
          <span className={styles.tick}>
            <CheckIcon />
            no accounts
          </span>
          <span className={styles.tick}>
            <CheckIcon />
            no logs, no history
          </span>
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </div>

      <div className={styles.foot}>
        <div className={styles.footSide}>
          <span className={styles.footLabel}>CLIENT-SIDE</span>
          <span className={styles.cap}>
            <i className={styles.capDot} />
            Web Crypto
          </span>
          <span className={styles.cap}>
            <i className={styles.capDot} />
            WebRTC
          </span>
          <span className={styles.cap}>
            <i className={styles.capDot} />
            ECDSA
          </span>
          <span className={styles.cap}>
            <i className={styles.capDot} />
            AES-256-GCM
          </span>
          <span className={styles.cap}>
            <i className={styles.capDot} />
            HKDF
          </span>
        </div>
        <div className={styles.footSide}>
          <span className={styles.footLabel}>BUILD</span>
          <span className={styles.hash}>sha256 · {BUILD_HASH}</span>
          <button type='button' className={styles.footLink}>
            verify ↗
          </button>
        </div>
      </div>

      {joinOpen && <JoinDialog onClose={() => setJoinOpen(false)} />}
    </div>
  );
}
