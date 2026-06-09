import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="space-y-2 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Tourbillon</h1>
        <p className="text-lg text-muted-foreground">
          Open-source AI agent orchestration — Mastra.ai + LM Studio
        </p>
      </div>
      <div className="flex gap-4">
        <Button render={<Link href="/dashboard" />}>Open Dashboard</Button>
        <Button variant="outline" render={<a href="https://github.com/dcolley/tourbillon" target="_blank" rel="noopener noreferrer" />}>
          GitHub
        </Button>
      </div>
    </main>
  );
}
