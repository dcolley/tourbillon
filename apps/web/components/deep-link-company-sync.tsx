'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredCompanyId, setStoredCompanyId } from '@/lib/company-storage';
import { syncActiveCompanyAction } from '@/app/(dashboard)/company/actions';

export function DeepLinkCompanySync({
  requiredCompanyId,
  requiredCompanyName,
}: {
  requiredCompanyId: string;
  requiredCompanyName: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    if (syncingRef.current) return;

    const stored = getStoredCompanyId();
    if (stored === requiredCompanyId) return;

    syncingRef.current = true;

    async function adopt() {
      setStoredCompanyId(requiredCompanyId);
      const result = await syncActiveCompanyAction(requiredCompanyId);
      if (!result.ok) {
        syncingRef.current = false;
        return;
      }
      setMessage(`Switched to ${requiredCompanyName} to open this page.`);
      router.refresh();
    }

    void adopt();
  }, [requiredCompanyId, requiredCompanyName, router]);

  if (!message) return null;

  return (
    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
      {message}
    </div>
  );
}
