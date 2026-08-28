'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/** Toast once for ?killed= / ?error= query params, then strip them from the URL. */
export function HeartbeatRunQueryToast({
  killed,
  error,
  runId,
}: {
  killed?: string;
  error?: string | null;
  runId: string;
}) {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    if (!killed && !error) return;
    handled.current = true;

    if (error) {
      toast.error(error);
    } else if (killed) {
      toast.success('Heartbeat run force-killed');
    }

    router.replace(`/heartbeat/${runId}`, { scroll: false });
  }, [killed, error, runId, router]);

  return null;
}
