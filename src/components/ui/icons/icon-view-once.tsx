import type { IconProps } from './types'

export function IconViewOnce({ size = 20, ...props }: IconProps) {
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
      <circle cx="12" cy="12" r="10" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="none"
        fontSize="14"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        1
      </text>
    </svg>
  )
}
