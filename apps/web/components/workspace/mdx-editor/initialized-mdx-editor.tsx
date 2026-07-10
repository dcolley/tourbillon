'use client';

import { useMemo, type ForwardedRef } from 'react';
import { useTheme } from 'next-themes';
import {
  MDXEditor,
  type MDXEditorMethods,
  type MDXEditorProps,
  BoldItalicUnderlineToggles,
  CreateLink,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator,
  UndoRedo,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from '@mdxeditor/editor';

export default function InitializedMDXEditor({
  editorRef,
  onError,
  ...props
}: { editorRef: ForwardedRef<MDXEditorMethods> | null } & MDXEditorProps) {
  const { resolvedTheme } = useTheme();

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      markdownShortcutPlugin(),
      linkPlugin(),
      tablePlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BoldItalicUnderlineToggles />
            <Separator />
            <ListsToggle />
            <Separator />
            <CreateLink />
            <InsertTable />
            <InsertThematicBreak />
          </>
        ),
      }),
    ],
    []
  );

  const themeClass = resolvedTheme === 'dark' ? 'dark-theme' : 'light-theme';

  return (
    <MDXEditor
      plugins={plugins}
      className={themeClass}
      contentEditableClassName="text-sm leading-relaxed text-foreground max-w-none min-h-[420px] px-3 py-2"
      onError={(payload) => {
        const message =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : String(payload);
        console.error('[MDXEditor]', message);
        onError?.(payload);
      }}
      {...props}
      suppressHtmlProcessing
      ref={editorRef}
    />
  );
}
