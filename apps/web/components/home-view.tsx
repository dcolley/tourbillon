import { HomeLanding } from '@/components/home-landing';
import { HomeRedirect } from '@/components/home-redirect';

/**
 * UI-1: `/` keeps the public landing page for signed-out visitors; signed-in users are sent
 * to their stored view.
 */
export function HomeView({ signedIn }: { signedIn: boolean }) {
  return signedIn ? <HomeRedirect /> : <HomeLanding />;
}
