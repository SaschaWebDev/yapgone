import type { IconProps } from './types'

export function IconNotefade({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15a3 3 0 1 0 6 0 3 3 0 0 0-6 0z" />
      <path d="M12 12v1" />
      <path d="M12 16v1" />
    </svg>
  )
}
