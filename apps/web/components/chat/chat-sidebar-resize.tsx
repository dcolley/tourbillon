'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@/lib/utils';
import {
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  CHAT_SIDEBAR_WIDTH_MIN,
  clampChatSidebarWidth,
  readChatSidebarWidth,
  writeChatSidebarWidth,
} from '@/lib/chat-layout-storage';

/**
 * Persisted width for the docked chat sidebar, with pointer-drag resizing.
 * Middle content stays `flex-1` and shrinks/grows as this width changes.
 */
export function useChatSidebarWidth() {
  const [width, setWidth] = useState(CHAT_SIDEBAR_WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);

  useEffect(() => {
    const stored = readChatSidebarWidth();
    setWidth(stored);
    widthRef.current = stored;
  }, []);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const applyWidth = useCallback((next: number, persist: boolean) => {
    widthRef.current = next;
    setWidth(next);
    if (persist) writeChatSidebarWidth(next);
  }, []);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);

      const startX = event.clientX;
      const startWidth = widthRef.current;
      const container = handle.closest('[data-chat-resize-root]') as HTMLElement | null;
      const maxFromContainer = container
        ? Math.max(CHAT_SIDEBAR_WIDTH_MIN, container.clientWidth - 240)
        : undefined;

      const onMove = (moveEvent: PointerEvent) => {
        // Dragging the left edge leftward increases chat width.
        const next = clampChatSidebarWidth(
          startWidth + (startX - moveEvent.clientX),
          maxFromContainer,
        );
        applyWidth(next, false);
      };

      const onUp = (upEvent: PointerEvent) => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        setDragging(false);
        writeChatSidebarWidth(widthRef.current);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [applyWidth],
  );

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? 24 : -24;
      applyWidth(clampChatSidebarWidth(widthRef.current + delta), true);
    },
    [applyWidth],
  );

  return { width, dragging, onResizePointerDown, onResizeKeyDown };
}

export function ChatSidebarResizeHandle({
  onPointerDown,
  onKeyDown,
  dragging,
}: {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  dragging: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat pane"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'group/resize absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none md:flex',
        'items-stretch justify-center',
        dragging && 'bg-primary/10',
      )}
    >
      <span
        className={cn(
          'my-auto h-8 w-1 rounded-full bg-border transition-colors',
          'group-hover/resize:bg-muted-foreground/40',
          dragging && 'bg-primary',
        )}
      />
    </div>
  );
}
