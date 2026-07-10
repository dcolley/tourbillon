'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isDeepLinkPath } from '@/lib/company-link';
import { getStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';

/**
 * Ensures the active-company cookie matches localStorage once per company id.
 * Must not revalidate+re-run on every navigation — that creates an infinite loop
 * (sync → revalidatePath(layout) → remount/router update → sync again).
 */
export function CompanyGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const syncedCompanyIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const id = getStoredCompanyId();
      if (!id) {
        if (isDeepLinkPath(pathname)) {
          if (!cancelled) setReady(true);
          return;
        }
        router.replace('/select-company');
        return;
      }

      // Already synced this company in this session — do not revalidate again.
      if (syncedCompanyIdRef.current === id) {
        if (!cancelled) setReady(true);
        return;
      }

      const result = await syncActiveCompanyAction(id);
      if (cancelled) return;
      if (result.ok) {
        syncedCompanyIdRef.current = id;
      }
      setReady(true);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (!ready) {
    return (
      <div className="flex h-svh items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading workspace…</p>
      </div>
    );
  }

  return <>{children}</>;
}
