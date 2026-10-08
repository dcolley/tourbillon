'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { SAFE_NEXT_FALLBACK, sameOriginPath } from '@/lib/safe-next';

/**
 * POST the operator secret to /api/board/session. Exported for tests; never logs the secret.
 */
export async function postBoardSession(
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'invalid' | 'unreachable'> {
  try {
    const res = await fetchImpl('/api/board/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    return res.ok ? 'ok' : 'invalid';
  } catch {
    return 'unreachable';
  }
}

export function UnlockForm({ next }: { next: string }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await postBoardSession(secret);
      if (result === 'invalid') {
        setError('Invalid operator secret.');
        return;
      }
      if (result === 'unreachable') {
        setError('Could not reach the server.');
        return;
      }
      // #105 B2: re-check against the real origin before navigating (defence in depth).
      window.location.assign(sameOriginPath(next, window.location.origin) ?? SAFE_NEXT_FALLBACK);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Unlock Tourbillon</h1>
        <p className="text-sm text-muted-foreground">Enter the operator secret to open the board.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="board-secret">Operator secret</Label>
        <PasswordInput
          id="board-secret"
          autoComplete="current-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending || secret.length === 0} className="w-full">
        {pending ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  );
}
