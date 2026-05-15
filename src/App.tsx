import { Layout, ErrorBoundary } from '@/components'
import { useHashRoute } from '@/hooks'
import { Home, Chat } from '@/pages'

export function App() {
  const route = useHashRoute()

  return (
    <ErrorBoundary>
      {route.mode === 'chat' ? (
        <Layout>
          <Chat
            key={route.roomId}
            roomId={route.roomId}
            creatorPubKey={route.creatorPubKey}
            roomSettings={route.roomSettings}
          />
        </Layout>
      ) : (
        <Home />
      )}
    </ErrorBoundary>
  )
}
