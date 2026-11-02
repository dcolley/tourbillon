'use client';

/**
 * CHAT-SEND-KEY: the "Send message with" control, mounted in each chat's settings cluster (the
 * Control-Pane chat header as its own menu, the assistant chat ⋯ menu as a section inside it). Both
 * drive the single stored preference (lib/chat-send-key), so both surfaces — and every other tab —
 * move together.
 */
import { CornerDownLeft, Keyboard, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CHAT_SEND_KEY_MODE_DESCRIPTIONS,
  CHAT_SEND_KEY_MODE_LABELS,
  CHAT_SEND_KEY_SETTINGS_LABEL,
  isChatSendKeyMode,
  type ChatSendKeyMode,
} from '@/lib/chat-send-key';
import { useChatSendKeyMode } from './use-chat-send-key-mode';

/** The two modes as radio items; drop inside any DropdownMenuContent (must be a menu child). */
export function ChatSendKeyRadioGroup({
  mode,
  onModeChange,
}: {
  mode: ChatSendKeyMode;
  onModeChange: (mode: ChatSendKeyMode) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={mode}
      onValueChange={(value) => {
        if (isChatSendKeyMode(value)) onModeChange(value);
      }}
      data-slot="chat-send-key-group"
    >
      <DropdownMenuLabel>{CHAT_SEND_KEY_SETTINGS_LABEL}</DropdownMenuLabel>
      <DropdownMenuRadioItem value="enter_sends" className="gap-2" data-send-key-mode="enter_sends">
        <CornerDownLeft className="size-3.5 text-muted-foreground" />
        <span className="flex flex-col">
          <span>{CHAT_SEND_KEY_MODE_LABELS.enter_sends}</span>
          <span className="text-xs text-muted-foreground">
            {CHAT_SEND_KEY_MODE_DESCRIPTIONS.enter_sends}
          </span>
        </span>
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        value="mod_enter_sends"
        className="gap-2"
        data-send-key-mode="mod_enter_sends"
      >
        <Send className="size-3.5 text-muted-foreground" />
        <span className="flex flex-col">
          <span>{CHAT_SEND_KEY_MODE_LABELS.mod_enter_sends}</span>
          <span className="text-xs text-muted-foreground">
            {CHAT_SEND_KEY_MODE_DESCRIPTIONS.mod_enter_sends}
          </span>
        </span>
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

export interface ChatSendKeyMenuProps {
  /** Optional override (hosts that hold the pref elsewhere); defaults to the stored pref. */
  mode?: ChatSendKeyMode;
  onModeChange?: (mode: ChatSendKeyMode) => void;
}

/** Standalone menu button for chat headers that have no ⋯ menu of their own. */
export function ChatSendKeyMenu({ mode: modeOverride, onModeChange }: ChatSendKeyMenuProps) {
  const [stored, setStored] = useChatSendKeyMode();
  const mode = modeOverride ?? stored;
  const change = onModeChange ?? setStored;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={CHAT_SEND_KEY_SETTINGS_LABEL}
            aria-label={CHAT_SEND_KEY_SETTINGS_LABEL}
            data-slot="chat-send-key-menu"
          />
        }
      >
        <Keyboard className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <ChatSendKeyRadioGroup mode={mode} onModeChange={change} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
