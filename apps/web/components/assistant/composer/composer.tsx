'use client';

/**
 * CHAT-1: the assistant composer.
 *
 * `Composer` owns a composer controller (composer-controller.ts) for one agent thread and renders
 * `ComposerView`. The chat client plugs in through two props: `runStatus` (idle / starting /
 * running / stopping) and `controls` (send / steer / stop) — the shape of the AGUI-1b chat hook.
 */
import * as React from 'react';
import { FileText, LoaderCircle, Paperclip, Pencil, Send, Square, Trash2, Undo2, X, Zap } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { CHAT_ATTACHMENT_ACCEPT, CHAT_ATTACHMENT_MAX_BYTES, CHAT_ATTACHMENT_MAX_FILES, formatBytes } from '@/lib/chat-attachments';
import {
  createComposerController,
  type ComposerController,
  type ComposerControls,
  type ComposerRunStatus,
  type ComposerState,
  type UploadAttachment,
} from './composer-controller';
import { createDraftStore, draftKey, type DraftStore } from './draft-store';
import { createAttachmentUploader } from './upload';

export interface ComposerProps {
  agentId: string;
  /** Thread the draft belongs to (unset for a new conversation). */
  threadId?: string | null;
  runStatus: ComposerRunStatus;
  controls: ComposerControls;
  /** Disables the composer (e.g. while the chat is still connecting). */
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Overrides for tests / other hosts. */
  upload?: UploadAttachment;
  drafts?: DraftStore;
}

export function Composer(props: ComposerProps) {
  // A new agent / thread gets a fresh controller (and its own draft).
  return <ComposerForThread key={`${props.agentId}:${props.threadId ?? ''}`} {...props} />;
}

function ComposerForThread({
  agentId,
  threadId,
  runStatus,
  controls,
  disabled,
  placeholder,
  className,
  upload,
  drafts,
}: ComposerProps) {
  const [controller] = React.useState(() =>
    createComposerController({
      controls,
      upload: upload ?? createAttachmentUploader(agentId, threadId),
      drafts: drafts ?? createDraftStore(),
      draftKey: draftKey(agentId, threadId),
      runStatus,
    }),
  );

  // Latest controls from the chat client, used when an action runs.
  React.useEffect(() => {
    controller.setControls(controls);
  }, [controller, controls]);

  React.useEffect(() => {
    controller.setRunStatus(runStatus);
  }, [controller, runStatus]);

  // Cancel uploads still in flight when the composer goes away.
  React.useEffect(() => () => controller.cancelUploads(), [controller]);

  return <ConnectedComposer controller={controller} disabled={disabled} placeholder={placeholder} className={className} />;
}

function ConnectedComposer({
  controller,
  ...rest
}: { controller: ComposerController } & Pick<ComposerProps, 'disabled' | 'placeholder' | 'className'>) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return <ComposerView state={state} controller={controller} {...rest} />;
}

export function initialViewState(runStatus: ComposerRunStatus = 'idle'): ComposerState {
  return {
    text: '',
    attachments: [],
    queue: [],
    runStatus,
    submitting: false,
    dragging: false,
    notices: [],
    editing: null,
  };
}

export interface ComposerViewProps {
  state: ComposerState;
  /** null renders a read-only placeholder (before mount). */
  controller: ComposerController | null;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/** Stateless view (no hooks): everything comes from `state`, every action goes to `controller`. */
export function ComposerView({ state, controller, disabled, placeholder, className }: ComposerViewProps) {
  const off = disabled || !controller;
  const running = state.runStatus !== 'idle';
  const stopping = state.runStatus === 'stopping';
  const hasContent = state.text.trim().length > 0 || state.attachments.length > 0;
  const uploading = state.attachments.some((a) => a.status === 'uploading');
  const canSubmit = !off && hasContent && !uploading && !state.submitting;

  return (
    <div
      data-slot="composer"
      data-run-status={state.runStatus}
      className={cn('relative flex flex-col gap-2 rounded-xl border bg-background p-2', state.dragging && 'ring-2 ring-ring', className)}
      onDragEnter={(e) => controller?.handleDragEnter(e)}
      onDragOver={(e) => controller?.handleDragOver(e)}
      onDragLeave={() => controller?.handleDragLeave()}
      onDrop={(e) => controller?.handleDrop(e)}
    >
      {state.dragging ? (
        <div
          data-slot="composer-dropzone"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/90 text-sm text-muted-foreground"
        >
          Drop files to attach (up to {CHAT_ATTACHMENT_MAX_FILES}, {formatBytes(CHAT_ATTACHMENT_MAX_BYTES)} each)
        </div>
      ) : null}

      {state.queue.length > 0 ? (
        <ol data-slot="composer-queue" aria-label="Queued follow-ups" className="flex flex-col gap-1">
          {state.queue.map((item, i) => {
            const editing = state.editing?.id === item.id;
            return (
              <li key={item.id} data-queue-id={item.id} className="flex items-start gap-2 rounded-lg bg-muted/60 px-2 py-1 text-sm">
                <span className="mt-0.5 text-xs text-muted-foreground">{i + 1}.</span>
                {editing ? (
                  <Textarea
                    aria-label="Edit queued message"
                    value={state.editing?.text ?? ''}
                    onChange={(e) => controller?.setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        controller?.saveEdit();
                      } else if (e.key === 'Escape') controller?.cancelEdit();
                    }}
                    className="min-h-8 flex-1"
                  />
                ) : (
                  <span className="flex-1 whitespace-pre-wrap break-words">
                    {item.text || <em className="text-muted-foreground">(attachments only)</em>}
                    {item.attachments.length > 0 ? (
                      <span className="ml-1 text-xs text-muted-foreground">+{item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}</span>
                    ) : null}
                  </span>
                )}
                {editing ? (
                  <>
                    <Button size="xs" variant="secondary" onClick={() => controller?.saveEdit()}>Save</Button>
                    <Button size="icon-xs" variant="ghost" aria-label="Cancel edit" onClick={() => controller?.cancelEdit()}><Undo2 /></Button>
                  </>
                ) : (
                  <Button size="icon-xs" variant="ghost" aria-label="Edit queued message" disabled={off} onClick={() => controller?.startEdit(item.id)}><Pencil /></Button>
                )}
                <Button size="icon-xs" variant="ghost" aria-label="Remove queued message" disabled={off} onClick={() => controller?.removeQueued(item.id)}><Trash2 /></Button>
              </li>
            );
          })}
          {!running ? (
            <li>
              <Button size="xs" variant="outline" disabled={off || state.submitting} onClick={() => void controller?.sendNextQueued()}>Send next queued</Button>
            </li>
          ) : null}
        </ol>
      ) : null}

      {state.attachments.length > 0 ? (
        <ul data-slot="composer-attachments" aria-label="Attachments" className="flex flex-wrap gap-1">
          {state.attachments.map((a) => (
            <li
              key={a.id}
              data-attachment-id={a.id}
              data-status={a.status}
              className="flex max-w-60 items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs"
            >
              {a.status === 'uploading' ? <LoaderCircle className="size-3 animate-spin" aria-label="Uploading" /> : <FileText className="size-3" />}
              <span className="truncate" title={a.name}>{a.name}</span>
              <span className="text-muted-foreground">{formatBytes(a.size)}</span>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${a.name}`} disabled={off} onClick={() => controller?.removeAttachment(a.id)}><X /></Button>
            </li>
          ))}
        </ul>
      ) : null}

      {state.notices.length > 0 ? (
        <ul data-slot="composer-notices" role="alert" className="flex flex-col gap-1">
          {state.notices.map((n, i) => (
            <li key={`${i}-${n.message}`} className={cn('flex items-start gap-1 rounded-md px-2 py-1 text-xs', n.kind === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
              <span className="flex-1">{n.message}</span>
              <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => controller?.dismissNotice(i)}><X /></Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Textarea
        aria-label="Message"
        value={state.text}
        disabled={off}
        placeholder={placeholder ?? (running ? 'Queue a follow-up, or steer the agent…' : 'Message the agent…')}
        onChange={(e) => controller?.setText(e.target.value)}
        onKeyDown={(e) => {
          controller?.handleKeyDown(e);
        }}
        onPaste={(e) => {
          controller?.handlePaste(e);
        }}
        className="max-h-60 min-h-12 resize-none border-0 focus-visible:ring-0"
      />

      <div className="flex items-center gap-1">
        <label
          aria-label="Attach files"
          title={`Attach files (up to ${CHAT_ATTACHMENT_MAX_FILES}, ${formatBytes(CHAT_ATTACHMENT_MAX_BYTES)} each)`}
          aria-disabled={off || undefined}
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), off ? 'pointer-events-none opacity-50' : 'cursor-pointer')}
        >
          <Paperclip />
          <input
            type="file"
            multiple
            disabled={off}
            accept={CHAT_ATTACHMENT_ACCEPT}
            data-slot="composer-file-input"
            className="sr-only"
            onChange={(e) => {
              if (e.target.files) controller?.addFiles(e.target.files, 'picker');
              e.target.value = '';
            }}
          />
        </label>
        <span className="flex-1 text-xs text-muted-foreground">
          {running ? (stopping ? 'Stopping…' : 'Agent is working — Enter queues, Ctrl+Enter steers') : 'Enter to send, Shift+Enter for a new line'}
        </span>
        {running ? (
          <>
            <Button size="sm" variant="outline" disabled={!canSubmit || stopping} onClick={() => void controller?.steer()}>
              <Zap /> Steer
            </Button>
            <Button size="sm" variant="secondary" disabled={!canSubmit} onClick={() => void controller?.primary()}>
              Queue follow-up
            </Button>
            <Button size="sm" variant="destructive" disabled={off || stopping} onClick={() => controller?.stop()}>
              <Square /> Stop
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={!canSubmit} onClick={() => void controller?.primary()}>
            <Send /> Send
          </Button>
        )}
      </div>
    </div>
  );
}
