import type { IconProps } from './types'

export function IconPrediction({ size = 20, ...props }: IconProps) {
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
      <circle cx="12" cy="10" r="7" />
      <path d="M12 3v1" />
      <path d="M12 17v1" />
      <path d="M5.3 6.3l.7.7" />
      <path d="M18 7l.7-.7" />
      <path d="M9 21h6" />
      <path d="M10 21v-3" />
      <path d="M14 21v-3" />
      <path d="M12 7v4l2 2" />
    </svg>
  )
}
