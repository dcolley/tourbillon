import { UnlockForm } from './unlock-form';

/** Only allow same-origin relative redirects after unlock. */
function safeNext(next: string | string[] | undefined): string {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/dashboard';
  return v;
}

/** #105: unlock the board UI with the operator secret (TOURBILLON_BOARD_SECRET). */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-svh items-center justify-center p-8">
      <UnlockForm next={safeNext(next)} />
    </main>
  );
}
