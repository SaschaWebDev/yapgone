import type { IconProps } from './types'

export function IconPerson({ size = 14, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor' {...props}>
      <circle cx='12' cy='7' r='4' />
      <path d='M12 11c-5 0-8 3-8 6.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2.5c0-3.5-3-6.5-8-6.5Z' />
    </svg>
  )
}
