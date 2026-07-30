'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ActionResult } from '@/lib/action-result';

/** Toast on ActionResult changes; navigate when redirectTo is set. */
export function useActionToast(state: ActionResult | null) {
  const router = useRouter();
  const lastRef = useRef<ActionResult | null>(null);

  useEffect(() => {
    if (!state || state === lastRef.current) return;
    lastRef.current = state;

    if (state.ok) {
      toast.success(state.message);
      if (state.redirectTo) {
        router.replace(state.redirectTo);
      } else {
        router.refresh();
      }
    } else {
      toast.error(state.error);
    }
  }, [state, router]);
}
