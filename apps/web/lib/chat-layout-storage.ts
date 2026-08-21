export const CHAT_LAYOUT_STORAGE_KEY = 'tourbillon.chat.layoutMode';
export const CHAT_SIDEBAR_WIDTH_STORAGE_KEY = 'tourbillon.chat.sidebarWidth';

export const CHAT_LAYOUT_MODES = ['fab', 'popover', 'sidebar'] as const;

export type ChatLayoutMode = (typeof CHAT_LAYOUT_MODES)[number];

export const CHAT_LAYOUT_MODE_LABELS: Record<ChatLayoutMode, string> = {
  fab: 'Hidden (button)',
  popover: 'Pop-over',
  sidebar: 'Right sidebar',
};

/** Default / clamp for the docked chat sidebar width (px). */
export const CHAT_SIDEBAR_WIDTH_DEFAULT = 448;
export const CHAT_SIDEBAR_WIDTH_MIN = 280;
export const CHAT_SIDEBAR_WIDTH_MAX = 900;

export function isChatLayoutMode(value: unknown): value is ChatLayoutMode {
  return (
    typeof value === 'string' &&
    (CHAT_LAYOUT_MODES as readonly string[]).includes(value)
  );
}

export function clampChatSidebarWidth(width: number, max = CHAT_SIDEBAR_WIDTH_MAX): number {
  if (!Number.isFinite(width)) return CHAT_SIDEBAR_WIDTH_DEFAULT;
  return Math.min(max, Math.max(CHAT_SIDEBAR_WIDTH_MIN, Math.round(width)));
}

export function readChatLayoutMode(): ChatLayoutMode {
  if (typeof window === 'undefined') return 'popover';
  try {
    const raw = localStorage.getItem(CHAT_LAYOUT_STORAGE_KEY);
    if (isChatLayoutMode(raw)) return raw;
  } catch {
    // ignore
  }
  return 'popover';
}

export function writeChatLayoutMode(mode: ChatLayoutMode): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

export function readChatSidebarWidth(): number {
  if (typeof window === 'undefined') return CHAT_SIDEBAR_WIDTH_DEFAULT;
  try {
    const raw = localStorage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null) return CHAT_SIDEBAR_WIDTH_DEFAULT;
    return clampChatSidebarWidth(Number(raw));
  } catch {
    return CHAT_SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeChatSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      CHAT_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampChatSidebarWidth(width)),
    );
  } catch {
    // ignore
  }
}
