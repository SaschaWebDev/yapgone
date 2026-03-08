import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import styles from './ErrorBoundary.module.css'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally no-op — no telemetry
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.wrapper}>
          <p className={styles.message}>Something went wrong.</p>
          <a href="/" className={styles.link}>Start over</a>
        </div>
      )
    }
    return this.props.children
  }
}
