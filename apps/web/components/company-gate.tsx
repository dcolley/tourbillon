'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isDeepLinkPath } from '@/lib/company-link';
import { getStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';

export function CompanyGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

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

      await syncActiveCompanyAction(id);
      if (!cancelled) setReady(true);
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
