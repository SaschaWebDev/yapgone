import type { IconProps } from './types';

export function IconViewOnce({ size = 20, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.5}
      strokeLinecap='round'
      strokeLinejoin='round'
      {...props}
    >
      {/* Bomb body */}
      <circle cx='11' cy='14' r='8' />
      {/* Neck / cap */}
      <path d='M 13.5 7.5 L 15 5.5 L 17.5 7 L 16 9' fill='none' />
      {/* Fuse */}
      <path d='M 16.2 6.2 Q 18.5 4 20 2.5' fill='none' />
      {/* Sparks */}
      <line x1='20' y1='2.5' x2='21.5' y2='1' />
      <line x1='20' y1='2.5' x2='22' y2='3' />
      <line x1='20' y1='2.5' x2='21' y2='4' />
      <line x1='20' y1='2.5' x2='18.5' y2='1.5' />
      {/* Timer label */}
      <text
        x='11'
        y='14'
        textAnchor='middle'
        dominantBaseline='central'
        fill='currentColor'
        stroke='none'
        fontSize='6'
        fontWeight='700'
        fontFamily='system-ui, sans-serif'
      >
        15s
      </text>
    </svg>
  );
}
