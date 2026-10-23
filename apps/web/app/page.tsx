import { HomeView } from '@/components/home-view';
import { hasBoardSession } from '@/lib/company';

/**
 * `/` stays public (proxy.ts). Signed out → the landing page as before; signed in (board
 * session) → redirect to the stored view, default /assistant.
 */
export default async function HomePage() {
  return <HomeView signedIn={await hasBoardSession()} />;
}
