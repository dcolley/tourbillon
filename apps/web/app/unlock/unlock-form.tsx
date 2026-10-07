'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function UnlockForm({ next }: { next: string }) {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/board/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        setError('Invalid operator secret.');
        return;
      }
      window.location.assign(next);
    } catch {
      setError('Could not reach the server.');
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
        <Input
          id="board-secret"
          type="password"
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
