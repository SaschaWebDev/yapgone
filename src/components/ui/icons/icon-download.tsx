import type { IconProps } from './types'

export function IconDownload({ size = 20, ...props }: IconProps) {
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
      <path d="M12 3v13m0 0l-4-4m4 4l4-4" />
      <path d="M5 20h14" />
    </svg>
  )
}
