import styles from './PatternedCircle.module.css'

interface PatternedCircleProps {
  color: string
  patternCss: string
  patternSize: string
  size?: string
}

export function PatternedCircle({ color, patternCss, patternSize, size }: PatternedCircleProps) {
  return (
    <span
      className={styles.circle}
      style={{
        backgroundColor: color,
        backgroundImage: patternCss !== 'none' ? patternCss : undefined,
        backgroundSize: patternCss !== 'none' ? patternSize : undefined,
        ...(size ? { width: size, height: size } : {}),
      }}
    />
  )
}
