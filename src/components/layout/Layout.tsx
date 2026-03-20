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
        <div className={styles.headerLeft}>
          <a href='/' className={styles.logo}>
            <img src='/yapgone-logo.png' alt='' className={styles.logoIcon} />
            yapgone
          </a>
          <span className={styles.tagline}>
            encrypted yapping, gone for good
          </span>
        </div>
        <button
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <IconSun size={24} /> : <IconMoon size={24} />}
        </button>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
