'use client';

import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { useTheme } from 'next-themes';

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
    return lang ? [lang] : [];
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
      className={className}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
      }}
    />
  );
}
