'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { APP_VIEW_HOME_PATHS, APP_VIEW_LABELS, homeRedirectPath } from '@/lib/view-preference';

/** What a signed-in user sees for a moment at `/` before the redirect (and if JS is off). */
export function HomeRedirectView() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <p className="text-sm text-muted-foreground">Opening Tourbillon…</p>
      <nav aria-label="Views" className="flex gap-4 text-sm">
        <Link className="underline underline-offset-4" href={APP_VIEW_HOME_PATHS.assistant}>
          {APP_VIEW_LABELS.assistant}
        </Link>
        <Link className="underline underline-offset-4" href={APP_VIEW_HOME_PATHS.control}>
          {APP_VIEW_LABELS.control}
        </Link>
      </nav>
    </main>
  );
}

/**
 * UI-1: signed-in users at `/` go to their stored view (assistant by default, see
 * lib/view-preference.ts). The preference lives in localStorage, so this runs client-side.
 */
export function HomeRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(homeRedirectPath());
  }, [router]);

  return <HomeRedirectView />;
}
