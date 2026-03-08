import type { ReactNode } from 'react'
import { useTheme } from '@/hooks'
import styles from './Layout.module.css'

interface LayoutProps {
  children: ReactNode
}

export function Layout({ children }: LayoutProps) {
  const { theme, toggleTheme } = useTheme()

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.logo}>yapgone</a>
        <button
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '\u2600' : '\u263E'}
        </button>
      </header>
      <main className={styles.main}>
        {children}
      </main>
      <footer className={styles.footer}>
        <span className={styles.tagline}>speak freely, then let it go</span>
      </footer>
    </div>
  )
}
