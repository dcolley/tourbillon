/** CHAT-2: copy text from the assistant chat (code blocks, tables). */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/** The browser clipboard, or null (server render, insecure context, unsupported browser). */
export function browserClipboard(): ClipboardLike | null {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  return clipboard && typeof clipboard.writeText === 'function' ? clipboard : null;
}

/** Writes exactly `text`; resolves false when there is no clipboard or the write is refused. */
export async function copyText(text: string, clipboard: ClipboardLike | null = browserClipboard()): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
