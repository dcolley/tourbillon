import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Paperclip Mastra',
  description: 'Open-source AI agent orchestration',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
