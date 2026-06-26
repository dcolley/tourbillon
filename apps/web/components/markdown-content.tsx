'use client';

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveWorkspaceLink } from '@/lib/workspace-links';

interface MarkdownContentProps {
  content: string;
  className?: string;
  /** When set, relative links resolve against this workspace file path. */
  workspacePath?: string | null;
  /** Navigate to another workspace file (in-app). */
  onWorkspaceNavigate?: (path: string) => void;
}

function createMarkdownComponents(
  workspacePath: string | null | undefined,
  onWorkspaceNavigate: ((path: string) => void) | undefined
) {
  return {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-lg font-bold mt-4 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-base font-bold mt-3 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className="block font-mono text-xs bg-muted/60 rounded p-3 overflow-x-auto my-2">
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-xs bg-muted/60 rounded px-1 py-0.5">{children}</code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto">{children}</pre>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const workspaceTarget =
      href && workspacePath && onWorkspaceNavigate
        ? resolveWorkspaceLink(href, workspacePath)
        : null;

    if (workspaceTarget && onWorkspaceNavigate) {
      return (
        <a
          href={`/workspace?path=${encodeURIComponent(workspaceTarget)}`}
          onClick={(e) => {
            e.preventDefault();
            onWorkspaceNavigate(workspaceTarget);
          }}
          className="text-primary underline underline-offset-2 hover:opacity-80 cursor-pointer"
        >
          {children}
        </a>
      );
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    );
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold bg-muted/40">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="my-3 border-border" />,
  };
}

export function MarkdownContent({
  content,
  className,
  workspacePath,
  onWorkspaceNavigate,
}: MarkdownContentProps) {
  const [mode, setMode] = useState<'parsed' | 'raw'>('parsed');
  const markdownComponents = useMemo(
    () => createMarkdownComponents(workspacePath, onWorkspaceNavigate),
    [workspacePath, onWorkspaceNavigate]
  );

  return (
    <div className={className}>
      <div className="flex justify-end mb-1">
        <div className="inline-flex rounded-md border text-xs overflow-hidden">
          <button
            type="button"
            onClick={() => setMode('parsed')}
            className={`px-2 py-0.5 transition-colors ${
              mode === 'parsed'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Parsed
          </button>
          <button
            type="button"
            onClick={() => setMode('raw')}
            className={`px-2 py-0.5 border-l transition-colors ${
              mode === 'raw'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Raw
          </button>
        </div>
      </div>

      {mode === 'parsed' ? (
        <div className="text-sm leading-relaxed break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted/30 rounded-md p-3 border">
          {content}
        </pre>
      )}
    </div>
  );
}
