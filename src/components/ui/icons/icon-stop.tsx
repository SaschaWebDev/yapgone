import type { IconProps } from './types'

export function IconStop({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      {...props}
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}
