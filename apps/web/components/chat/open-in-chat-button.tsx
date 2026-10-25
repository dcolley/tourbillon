'use client';

/**
 * UI-3: "Open in chat" on Control Pane pages. Opens the page's default agent (the one the page
 * gives ChatPageContext) in the assistant view with the page as context
 * (lib/assistant/open-in-chat.ts). Renders nothing when the page has no default agent.
 * Following the link switches to the assistant view, so it is stored as the view preference.
 */
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openInChatHref, type OpenInChatContextType } from '@/lib/assistant/open-in-chat';
import { writeViewPreference } from '@/lib/view-preference';

export interface OpenInChatButtonProps {
  /** Url key of the page's default agent; missing means no button. */
  agentUrlKey?: string | null;
  agentName?: string | null;
  contextType: OpenInChatContextType;
  contextId?: string | null;
  contextTitle?: string | null;
  className?: string;
  /** Called when the link is followed (default: store the assistant view as the preference). */
  onOpen?: () => void;
}

/** Store the assistant view as the preferred view (the link leaves the Control Pane). */
export function rememberAssistantView(): void {
  writeViewPreference('assistant');
}

/** No hooks: callable directly in tests. */
export function OpenInChatButton({
  agentUrlKey,
  agentName,
  contextType,
  contextId,
  contextTitle,
  className,
  onOpen = rememberAssistantView,
}: OpenInChatButtonProps) {
  const href = openInChatHref({ agentUrlKey, contextType, contextId, contextTitle });
  if (!href) return null;
  const label = agentName ? `Open in chat with ${agentName}` : 'Open in chat';
  return (
    <Link
      href={href}
      data-slot="open-in-chat"
      title={label}
      aria-label={label}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}
      onClick={() => onOpen()}
    >
      <MessageSquare />
      Open in chat
    </Link>
  );
}
