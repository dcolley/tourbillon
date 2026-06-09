import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">Paperclip Mastra</h1>
        <p className="text-muted-foreground text-lg">
          Open-source AI agent orchestration — Mastra.ai + LM Studio
        </p>
      </div>
      <div className="flex gap-4">
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Open Dashboard
        </Link>
        <a
          href="https://github.com/dcolley/paperclip-mastra"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md border border-border px-6 py-2.5 text-sm font-medium hover:bg-accent transition-colors"
        >
          GitHub
        </a>
      </div>
    </main>
  );
}
