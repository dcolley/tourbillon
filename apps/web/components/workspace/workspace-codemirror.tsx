'use client';

import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { EditorView } from '@codemirror/view';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

function languageForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return markdown();
  if (lower.endsWith('.json')) return json();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return yaml();
  if (lower.endsWith('.tsx')) return javascript({ jsx: true, typescript: true });
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return javascript({ typescript: true });
  }
  if (lower.endsWith('.jsx')) return javascript({ jsx: true });
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    lower.endsWith('.less') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.bash') ||
    lower.endsWith('.zsh') ||
    lower.endsWith('.sql') ||
    lower.endsWith('.py') ||
    lower.endsWith('.go') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.java') ||
    lower.endsWith('.kt') ||
    lower.endsWith('.vue') ||
    lower.endsWith('.svelte') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.txt')
  ) {
    return javascript();
  }
  return undefined;
}

const editorTheme = EditorView.theme({
  '&.cm-editor .cm-content': { fontSize: '12px' },
  '&.cm-editor .cm-gutters': { fontSize: '12px' },
});

export function WorkspaceCodeMirror({
  path,
  value,
  readOnly,
  onChange,
  className,
}: {
  path: string;
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => {
    const lang = languageForPath(path);
    return [EditorView.lineWrapping, editorTheme, ...(lang ? [lang] : [])];
  }, [path]);

  const theme = resolvedTheme === 'dark' ? vscodeDark : vscodeLight;

  return (
    <CodeMirror
      value={value}
      height="480px"
      theme={theme}
      extensions={extensions}
      editable={!readOnly}
      onChange={onChange}
      className={cn('max-w-full overflow-hidden', className)}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
      }}
    />
  );
}
