import type { ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

type Intent = 'destructive' | 'positive' | 'neutral'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: Intent
  size?: Size
}

export function Button({
  intent = 'neutral',
  size = 'md',
  type = 'button',
  className,
  ...props
}: ButtonProps) {
  const cls = [
    styles.button,
    styles[size],
    styles[intent],
    className,
  ].filter(Boolean).join(' ')

  return <button className={cls} type={type} {...props} />
}
