'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

const SAVED_MESSAGES: Record<string, string> = {
  role: 'Role saved. Skills, toolsets, and assigned tools were reset to role defaults.',
};

/** Toast once for legacy ?saved= / ?error= / ?killed= query params, then strip them from the URL. */
export function AgentQueryToast({
  saved,
  error,
  killed,
  urlKey,
}: {
  saved?: string;
  error?: string | null;
  killed?: string;
  urlKey: string;
}) {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    if (!saved && !error && !killed) return;
    handled.current = true;

    if (error) {
      toast.error(error);
    } else if (killed) {
      toast.success('Heartbeat run force-killed');
    } else if (saved) {
      toast.success(SAVED_MESSAGES[saved] ?? 'Saved.');
    }

    router.replace(`/agent/${urlKey}`, { scroll: false });
  }, [saved, error, killed, urlKey, router]);

  return null;
}
