import Link from 'next/link';

/** Unknown agent or thread in an assistant URL (same page whether it is missing or another company's). */
export default function AssistantNotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center" data-assistant-not-found>
      <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">This agent or thread is not available in the current company.</p>
      <Link href="/assistant" className="text-sm underline underline-offset-4">
        Back to the assistant
      </Link>
    </main>
  );
}
