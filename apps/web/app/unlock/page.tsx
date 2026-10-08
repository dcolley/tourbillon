import { safeNext } from '@/lib/safe-next';
import { UnlockForm } from './unlock-form';

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
