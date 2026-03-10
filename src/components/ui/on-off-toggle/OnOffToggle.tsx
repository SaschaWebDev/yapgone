import styles from './OnOffToggle.module.css';

export function OnOffToggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.toggle}>
      <div
        className={styles.slider}
        style={{
          width: 'calc(100% / 2 - 2px)',
          transform: `translateX(${enabled ? '100%' : '0%'})`,
        }}
      />
      <button
        type='button'
        className={`${styles.option} ${!enabled ? styles.optionActive : ''}`}
        onClick={onToggle}
        disabled={disabled}
      >
        off
      </button>
      <button
        type='button'
        className={`${styles.option} ${enabled ? styles.optionActive : ''}`}
        onClick={onToggle}
        disabled={disabled}
      >
        on
      </button>
    </div>
  );
}
