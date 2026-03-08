import { Layout, ErrorBoundary } from '@/components'
import { useHashRoute } from '@/hooks'
import { Home, Chat } from '@/pages'

export function App() {
  const route = useHashRoute()

  return (
    <ErrorBoundary>
      <Layout>
        {route.mode === 'chat' ? (
          <Chat roomId={route.roomId} creatorPubKey={route.creatorPubKey} />
        ) : (
          <Home />
        )}
      </Layout>
    </ErrorBoundary>
  )
}
