'use client';

/**
 * CHAT-2: message renderer for the assistant chat. Markdown (GFM) through react-markdown with no
 * raw HTML: HTML in a message is shown as text, never parsed into elements. Links open in a new
 * tab and only http(s), mailto and relative targets are kept. Images are shown as links, so
 * nothing is fetched just by showing a message. Code blocks and tables get copy controls; what is
 * copied is the text the message already shows.
 */
import * as React from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { copyText, type ClipboardLike } from '@/lib/assistant/clipboard';
import { hastText, tableRowsFromHast, tableToCsv, tableToTsv, type HastLike, type TableRows } from '@/lib/assistant/message-table';

const ALLOWED_PROTOCOL = /^(https?|mailto)$/i;

/** react-markdown's URL check, narrowed to http(s), mailto and relative URLs. */
export function chatUrlTransform(url: string): string {
  const safe = defaultUrlTransform(url);
  if (!safe) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(safe);
  return scheme && !ALLOWED_PROTOCOL.test(scheme[1]) ? '' : safe;
}

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

/** Language hint from a code element's `language-xxx` class, if it is a plain name. */
export function codeLanguage(className: unknown): string | undefined {
  const classes = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? className.split(/\s+/) : [];
  const hint = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length);
  return hint && LANGUAGE.test(hint) ? hint : undefined;
}

/** Language and exact text of a fenced code block (`<pre><code>`), without the final newline. */
export function codeBlockFromHast(pre: HastLike | undefined): { language?: string; code: string } {
  const code = pre?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  return { language: codeLanguage(code?.properties?.className), code: hastText(code ?? pre).replace(/\n$/, '') };
}

/** Copies `text`, then reports whether it worked (used for the "Copied" feedback). */
export function makeCopyHandler(
  text: string,
  onDone: (ok: boolean) => void,
  clipboard?: ClipboardLike | null,
): () => Promise<boolean> {
  return async () => {
    const ok = await (clipboard === undefined ? copyText(text) : copyText(text, clipboard));
    onDone(ok);
    return ok;
  };
}

function useCopied(): [string | null, (key: string, ok: boolean) => void] {
  const [copied, setCopied] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const mark = React.useCallback((key: string, ok: boolean) => {
    if (!ok) return;
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  }, []);
  return [copied, mark];
}

export interface CodeBlockViewProps {
  language?: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}

/** Stateless code block: language label, copy control, code as text. */
export function CodeBlockView({ language, code, copied, onCopy }: CodeBlockViewProps) {
  return (
    <div className="my-2 overflow-hidden rounded-md border bg-muted/40" data-code-block data-language={language ?? ''}>
      <div className="flex items-center justify-between border-b px-2 py-0.5 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? 'text'}</span>
        <Button type="button" size="xs" variant="ghost" aria-label="Copy code" data-copy="code" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className={`font-mono${language ? ` language-${language}` : ''}`}>{code}</code>
      </pre>
    </div>
  );
}

export function CodeBlock({ language, code, clipboard }: { language?: string; code: string; clipboard?: ClipboardLike | null }) {
  const [copied, mark] = useCopied();
  const onCopy = React.useMemo(() => makeCopyHandler(code, (ok) => mark('code', ok), clipboard), [code, mark, clipboard]);
  return <CodeBlockView language={language} code={code} copied={copied === 'code'} onCopy={() => void onCopy()} />;
}

export type TableCopyFormat = 'csv' | 'tsv';

/** Table text in the chosen format. */
export function tableCopyText(rows: TableRows, format: TableCopyFormat): string {
  return format === 'csv' ? tableToCsv(rows) : tableToTsv(rows);
}

export interface TableBlockViewProps {
  rows: TableRows;
  copied: TableCopyFormat | null;
  onCopy: (format: TableCopyFormat) => void;
  children?: React.ReactNode;
}

/** Stateless table block: copy as CSV / TSV, then the rendered table. */
export function TableBlockView({ rows, copied, onCopy, children }: TableBlockViewProps) {
  return (
    <div className="my-2" data-table-block data-rows={rows.length} data-columns={rows[0]?.length ?? 0}>
      {rows.length > 0 && (
        <div className="mb-1 flex justify-end gap-1">
          <Button type="button" size="xs" variant="ghost" data-copy="csv" onClick={() => onCopy('csv')}>
            {copied === 'csv' ? 'Copied' : 'Copy CSV'}
          </Button>
          <Button type="button" size="xs" variant="ghost" data-copy="tsv" onClick={() => onCopy('tsv')}>
            {copied === 'tsv' ? 'Copied' : 'Copy TSV'}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    </div>
  );
}

export function TableBlock({ rows, children, clipboard }: { rows: TableRows; children?: React.ReactNode; clipboard?: ClipboardLike | null }) {
  const [copied, mark] = useCopied();
  const onCopy = (format: TableCopyFormat) =>
    void makeCopyHandler(tableCopyText(rows, format), (ok) => mark(format, ok), clipboard)();
  return (
    <TableBlockView rows={rows} copied={copied === 'csv' || copied === 'tsv' ? copied : null} onCopy={onCopy}>
      {children}
    </TableBlockView>
  );
}

type WithNode = { node?: unknown; children?: React.ReactNode };
const asHast = (node: unknown) => node as HastLike | undefined;

/** Element overrides for chat messages. Exported for tests. */
export const chatMarkdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-bold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  // Fenced code: the whole <pre> becomes a code block; inline code stays inline.
  pre: ({ node }: WithNode) => {
    const { language, code } = codeBlockFromHast(asHast(node));
    return <CodeBlock language={language} code={code} />;
  },
  code: ({ children }) => <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">{children}</code>,
  table: ({ node, children }: WithNode) => <TableBlock rows={tableRowsFromHast(asHast(node))}>{children}</TableBlock>,
  th: ({ children }) => <th className="border border-border bg-muted/40 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2 hover:opacity-80">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // No remote image loads from a message: show the image as a link.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" data-image-link className="text-primary underline underline-offset-2">
        {alt ? `Image: ${alt}` : 'Image'}
      </a>
    ) : (
      <span>{alt}</span>
    ),
};

const REMARK_PLUGINS = [remarkGfm];

/** Markdown for one chat message. */
export function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`break-words leading-relaxed ${className ?? ''}`} data-chat-markdown>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={chatMarkdownComponents} urlTransform={chatUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
