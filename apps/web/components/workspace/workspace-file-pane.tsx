'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isMarkdownPath, isTextEditablePath, isTextViewablePath } from '@tourbillon/shared/company-workspace-types';
import { MarkdownContent } from '@/components/markdown-content';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WorkspaceCodeMirror } from '@/components/workspace/workspace-codemirror';
import { ForwardRefEditor } from '@/components/workspace/mdx-editor/forward-ref-editor';
import { VisualEditorErrorBoundary } from '@/components/workspace/mdx-editor/visual-editor-error-boundary';
import type { MDXEditorMethods } from '@mdxeditor/editor';

type MarkdownMode = 'preview' | 'visual' | 'source';
type TextMode = 'view' | 'edit';

function splitWorkspacePath(filePath: string): { dir: string; name: string } {
  const slash = filePath.lastIndexOf('/');
  if (slash === -1) return { dir: '', name: filePath };
  return { dir: filePath.slice(0, slash), name: filePath.slice(slash + 1) };
}

function joinWorkspacePath(dir: string, name: string): string {
  const base = name.trim().replace(/^\/+/, '');
  return dir ? `${dir}/${base}` : base;
}

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

async function renameFile(from: string, to: string): Promise<string> {
  const res = await fetch('/api/workspace/file', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, requireEditable: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to rename file (${res.status})`);
  }
  return body.path ?? to;
}

export function WorkspaceFilePane({
  path,
  hydratedPath,
  hydratedContent,
  startInEdit = false,
  onSaved,
  onNavigate,
  onStartInEditConsumed,
  deleteForm,
}: {
  path: string | null;
  hydratedPath: string | null;
  hydratedContent: string | null;
  startInEdit?: boolean;
  onSaved?: () => void;
  onNavigate?: (path: string) => void;
  onStartInEditConsumed?: () => void;
  deleteForm: React.ReactNode;
}) {
  const editable = path ? isTextEditablePath(path) : false;
  const viewable = path ? isTextViewablePath(path) : false;
  const readOnlyCode = viewable && !editable;
  const markdown = path ? isMarkdownPath(path) : false;

  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftName, setDraftName] = useState(() => (path ? splitWorkspacePath(path).name : ''));
  const [loading, setLoading] = useState(Boolean(path && viewable));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownMode>('preview');
  const [textMode, setTextMode] = useState<TextMode>('view');
  const mdxRef = useRef<MDXEditorMethods>(null);
  const usedHydrationRef = useRef(false);
  const usedStartInEditRef = useRef(false);
  const visualSeedRef = useRef('');
  const [visualSeed, setVisualSeed] = useState('');

  const pathParts = path ? splitWorkspacePath(path) : { dir: '', name: '' };
  const editing = markdown ? markdownMode !== 'preview' : textMode === 'edit';
  const nameDirty = editing && draftName.trim() !== pathParts.name;
  const contentDirty = editing && draft !== (content ?? '');
  const isDirty = nameDirty || contentDirty;

  useEffect(() => {
    usedStartInEditRef.current = false;
  }, [path, startInEdit]);

  useEffect(() => {
    if (!path || !viewable) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setMarkdownMode('preview');
      setTextMode('view');
      setSaveError(null);
      setDraftName(splitWorkspacePath(path).name);

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

        const shouldStartEdit =
          startInEdit &&
          isTextEditablePath(path) &&
          !usedStartInEditRef.current;
        if (shouldStartEdit) {
          usedStartInEditRef.current = true;
          onStartInEditConsumed?.();
          if (isMarkdownPath(path)) {
            visualSeedRef.current = text;
            setVisualSeed(text);
            setMarkdownMode('visual');
          } else {
            setTextMode('edit');
          }
        }
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
  }, [path, viewable, hydratedPath, hydratedContent, startInEdit, onStartInEditConsumed]);

  const enterMarkdownEdit = useCallback(
    (mode: 'visual' | 'source') => {
      const seed = content ?? '';
      setDraft(seed);
      setDraftName(pathParts.name);
      if (mode === 'visual') {
        visualSeedRef.current = seed;
        setVisualSeed(seed);
      }
      setMarkdownMode(mode);
    },
    [content, pathParts.name]
  );

  const enterTextEdit = useCallback(() => {
    setDraft(content ?? '');
    setDraftName(pathParts.name);
    setTextMode('edit');
  }, [content, pathParts.name]);

  const cancelEdit = useCallback(() => {
    setDraft(content ?? '');
    setDraftName(pathParts.name);
    setMarkdownMode('preview');
    setTextMode('view');
    setSaveError(null);
  }, [content, pathParts.name]);

  const handleSave = useCallback(async () => {
    if (!path) return;
    const nextName = draftName.trim();
    if (!nextName) {
      setSaveError('Filename is required.');
      return;
    }
    const nextPath = joinWorkspacePath(pathParts.dir, nextName);
    if (!isTextEditablePath(nextPath)) {
      setSaveError('Use an editable extension: .md, .txt, .json, .jsonl, .yaml, .yml, or .csv.');
      return;
    }

    const toSave =
      markdown && markdownMode === 'visual'
        ? (mdxRef.current?.getMarkdown() ?? draft)
        : draft;

    setSaving(true);
    setSaveError(null);
    let savePath = path;
    try {
      if (nextPath !== path) {
        savePath = await renameFile(path, nextPath);
      }
      await saveFileContent(savePath, toSave);
      setContent(toSave);
      setDraft(toSave);
      setDraftName(splitWorkspacePath(savePath).name);
      setMarkdownMode('preview');
      setTextMode('view');
      if (savePath !== path) {
        onNavigate?.(savePath);
      }
      onSaved?.();
    } catch (err) {
      // If rename succeeded but content save failed, keep the UI on the new path.
      if (savePath !== path) {
        onNavigate?.(savePath);
        onSaved?.();
      }
      setSaveError(err instanceof Error ? err.message : 'Failed to save file.');
    } finally {
      setSaving(false);
    }
  }, [path, pathParts.dir, draftName, draft, markdown, markdownMode, onNavigate, onSaved]);

  useEffect(() => {
    if (markdownMode !== 'visual' || !visualSeed) return;
    mdxRef.current?.setMarkdown(visualSeed);
  }, [markdownMode, visualSeed]);

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
        {editing ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 font-mono text-sm">
            {pathParts.dir ? (
              <span className="shrink-0 text-muted-foreground">{pathParts.dir}/</span>
            ) : null}
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              aria-label="Filename"
              className="h-8 max-w-xs font-mono text-sm"
            />
          </div>
        ) : (
          <p className="font-mono text-sm">{path}</p>
        )}
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
          <VisualEditorErrorBoundary onFallback={() => enterMarkdownEdit('source')}>
            <ForwardRefEditor
              ref={mdxRef}
              markdown={visualSeed}
              onChange={setDraft}
              key={`mdx-${path}-visual`}
            />
          </VisualEditorErrorBoundary>
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
