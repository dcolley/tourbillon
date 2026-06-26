'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isMarkdownPath, isTextEditablePath, isTextViewablePath } from '@tourbillon/shared/company-workspace-types';
import { MarkdownContent } from '@/components/markdown-content';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WorkspaceCodeMirror } from '@/components/workspace/workspace-codemirror';
import { ForwardRefEditor } from '@/components/workspace/mdx-editor/forward-ref-editor';
import type { MDXEditorMethods } from '@mdxeditor/editor';

type MarkdownMode = 'preview' | 'visual' | 'source';
type TextMode = 'view' | 'edit';

async function fetchFileContent(path: string): Promise<string> {
  const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load file (${res.status})`);
  }
  return res.text();
}

async function saveFileContent(path: string, content: string): Promise<void> {
  const res = await fetch('/api/workspace/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to save file (${res.status})`);
  }
}

export function WorkspaceFilePane({
  path,
  hydratedPath,
  hydratedContent,
  onSaved,
  onNavigate,
  deleteForm,
}: {
  path: string | null;
  hydratedPath: string | null;
  hydratedContent: string | null;
  onSaved?: () => void;
  onNavigate?: (path: string) => void;
  deleteForm: React.ReactNode;
}) {
  const editable = path ? isTextEditablePath(path) : false;
  const viewable = path ? isTextViewablePath(path) : false;
  const readOnlyCode = viewable && !editable;
  const markdown = path ? isMarkdownPath(path) : false;

  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(Boolean(path && viewable));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('preview');
  const [textMode, setTextMode] = useState<TextMode>('view');
  const mdxRef = useRef<MDXEditorMethods>(null);
  const usedHydrationRef = useRef(false);

  const isDirty =
    markdownMode !== 'preview' || textMode === 'edit'
      ? draft !== (content ?? '')
      : false;

  useEffect(() => {
    if (!path || !viewable) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setMarkdownMode('preview');
      setTextMode('view');
      setSaveError(null);

      try {
        let text: string;
        const canUseHydration =
          hydratedPath === path &&
          hydratedContent !== null &&
          !usedHydrationRef.current;
        if (canUseHydration) {
          usedHydrationRef.current = true;
          text = hydratedContent;
        } else {
          text = await fetchFileContent(path);
        }
        if (cancelled) return;
        setContent(text);
        setDraft(text);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load file.');
          setContent(null);
          setDraft('');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [path, viewable, hydratedPath, hydratedContent]);

  const enterMarkdownEdit = useCallback(
    (mode: 'visual' | 'source') => {
      setDraft(content ?? '');
      setMarkdownMode(mode);
    },
    [content]
  );

  const enterTextEdit = useCallback(() => {
    setDraft(content ?? '');
    setTextMode('edit');
  }, [content]);

  const cancelEdit = useCallback(() => {
    setDraft(content ?? '');
    setMarkdownMode('preview');
    setTextMode('view');
    setSaveError(null);
  }, [content]);

  const handleSave = useCallback(async () => {
    if (!path) return;
    const toSave =
      markdown && markdownMode === 'visual'
        ? (mdxRef.current?.getMarkdown() ?? draft)
        : draft;

    setSaving(true);
    setSaveError(null);
    try {
      await saveFileContent(path, toSave);
      setContent(toSave);
      setDraft(toSave);
      setMarkdownMode('preview');
      setTextMode('view');
      onSaved?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save file.');
    } finally {
      setSaving(false);
    }
  }, [path, draft, markdown, markdownMode, onSaved]);

  if (!path) {
    return (
      <p className="text-sm text-muted-foreground">Select a file from the tree to view or edit.</p>
    );
  }

  if (!viewable) {
    return (
      <div className="space-y-3">
        <p className="font-mono text-sm">{path}</p>
        <a
          href={`/api/workspace/file?path=${encodeURIComponent(path)}`}
          className="inline-flex text-sm text-primary underline"
        >
          Download file
        </a>
        {deleteForm}
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading file…</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (readOnlyCode) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-sm">{path}</p>
          <span className="text-xs text-muted-foreground">Read-only</span>
        </div>
        <WorkspaceCodeMirror path={path} value={content ?? ''} readOnly />
        <div className="border-t pt-3">{deleteForm}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm">{path}</p>
        <div className="flex flex-wrap items-center gap-2">
          {markdown && markdownMode === 'preview' && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" size="sm" variant="outline" />}
              >
                Edit
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => enterMarkdownEdit('visual')}>
                  Visual editor
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => enterMarkdownEdit('source')}>
                  Source
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {markdown && markdownMode !== 'preview' && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}

          {!markdown && textMode === 'view' && (
            <Button type="button" size="sm" variant="outline" onClick={enterTextEdit}>
              Edit
            </Button>
          )}

          {!markdown && textMode === 'edit' && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      </div>

      {isDirty && (
        <p className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</p>
      )}

      {markdown && markdownMode === 'preview' && (
        <MarkdownContent
          content={content ?? ''}
          workspacePath={path}
          onWorkspaceNavigate={onNavigate}
        />
      )}

      {markdown && markdownMode === 'visual' && (
        <div className="rounded-lg border overflow-hidden">
          <ForwardRefEditor
            ref={mdxRef}
            markdown={draft}
            onChange={setDraft}
            key={`mdx-${path}`}
          />
        </div>
      )}

      {markdown && markdownMode === 'source' && (
        <WorkspaceCodeMirror path={path} value={draft} onChange={setDraft} />
      )}

      {!markdown && (
        <WorkspaceCodeMirror
          path={path}
          value={textMode === 'edit' ? draft : (content ?? '')}
          readOnly={textMode === 'view'}
          onChange={textMode === 'edit' ? setDraft : undefined}
        />
      )}

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      {(markdownMode === 'preview' || textMode === 'view') && (
        <div className="border-t pt-3">{deleteForm}</div>
      )}
    </div>
  );
}
