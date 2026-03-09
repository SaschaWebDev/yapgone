import type { ReactNode } from 'react';
import { useTheme } from '@/hooks';
import { IconSun, IconMoon } from '../ui/icons';
import styles from './Layout.module.css';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href='/' className={styles.logo}>
          yapgone
        </a>
        <button
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <span className={styles.tagline}>
          speak freely, then let it be gone
        </span>
      </footer>
    </div>
  );
}
