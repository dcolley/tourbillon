'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { APP_VIEW_HOME_PATHS, APP_VIEW_LABELS, homeRedirectPath } from '@/lib/view-preference';

/**
 * UI-1: `/` sends the user to their stored view (assistant by default, see
 * lib/view-preference.ts). Both views sit behind the board session and company gate, so an
 * unauthenticated visitor ends up on /unlock with `next` set to that view.
 */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(homeRedirectPath());
  }, [router]);

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
