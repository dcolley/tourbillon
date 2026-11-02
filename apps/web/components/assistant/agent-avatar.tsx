/**
 * AGENT-AVATAR-UI: the agent avatar (v1 = blob shape + palette colour, no photo).
 * Presented from the agent's stored config (`runtimeConfig.avatar`, validated by
 * @tourbillon/shared/agent-avatar). When no config is set the avatar renders exactly today's
 * initials circle (no surprise rebrand).
 *
 * The optional ACTIVITY dot lives on the avatar (green = working, yellow = waiting, none =
 * idle — lib/assistant/presence.ts). The UNREAD dot is deliberately NOT part of this component:
 * it belongs to the list row, never the avatar.
 *
 * Server-safe (no hooks) so pages, server components and client components share it.
 */
import * as React from 'react';
import { AGENT_AVATAR_SHAPES, type AgentAvatarConfig } from '@tourbillon/shared/agent-avatar';
import {
  AVATAR_ACTIVITY_DOT_CLASS,
  type AvatarActivityDot,
} from '@/lib/assistant/presence';

export type AgentAvatarSize = 'row' | 'rail' | 'header' | 'preview';

const SIZE_BOX: Record<AgentAvatarSize, string> = {
  row: 'size-6',
  rail: 'size-8',
  header: 'size-12',
  preview: 'size-16',
};
const SIZE_TEXT: Record<AgentAvatarSize, string> = {
  row: 'text-[0.65rem]',
  rail: 'text-[0.65rem]',
  header: 'text-lg',
  preview: 'text-xl',
};

/** Same rule the sidebar has always used: up to two initials, '?' when blank. */
export const avatarInitials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

export interface AgentAvatarProps {
  name: string;
  /** The agent's config; null renders today's default initials circle. */
  config: AgentAvatarConfig | null;
  size?: AgentAvatarSize;
  /** Activity dot on the avatar (activity only — unread is never shown here). */
  activity?: AvatarActivityDot;
  /** Extra classes on the container (positioning only; colours are owned here). */
  className?: string;
  /**
   * Classes for the default (config=null) circle, so each surface keeps its current look
   * (e.g. the sidebar circle uses bg-muted, the agent page header bg-primary/10 text-primary).
   */
  defaultClassName?: string;
}

export function AgentAvatar({
  name,
  config,
  size = 'row',
  activity = null,
  className = '',
  defaultClassName = 'bg-muted',
}: AgentAvatarProps) {
  const box = `${SIZE_BOX[size]} ${SIZE_TEXT[size]}`;
  const dot = activity ? (
    <span
      aria-hidden
      className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-background ${AVATAR_ACTIVITY_DOT_CLASS[activity]}`}
      data-avatar-dot={activity}
    />
  ) : null;

  if (!config) {
    // Today's look: a plain initials circle (the sidebar circle markup).
    return (
      <span
        aria-hidden
        data-avatar="default"
        className={`relative flex shrink-0 items-center justify-center rounded-full font-semibold ${box} ${defaultClassName} ${className}`}
      >
        {avatarInitials(name)}
        {dot}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      data-avatar="custom"
      data-avatar-shape={config.shape}
      data-avatar-color={config.color}
      className={`relative flex shrink-0 items-center justify-center font-semibold text-white ${box} ${className}`}
    >
      <svg viewBox="0 0 64 64" className="absolute inset-0 size-full" focusable="false">
        <path d={AGENT_AVATAR_SHAPES[config.shape]} fill={config.color} />
      </svg>
      <span className="relative leading-none">{avatarInitials(name)}</span>
      {dot}
    </span>
  );
}

/** One selectable blob shape (the modal's organic-shapes grid). */
export function AgentShapeGlyph({
  shape,
  color,
  selected,
  onSelect,
  label,
}: {
  shape: keyof typeof AGENT_AVATAR_SHAPES;
  color: string;
  selected: boolean;
  onSelect: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      data-shape={shape}
      aria-pressed={selected}
      aria-label={label ?? `Shape: ${shape}`}
      onClick={onSelect}
      className={`flex size-10 items-center justify-center rounded-md border p-1 transition-colors ${
        selected ? 'border-primary bg-primary/10' : 'border-input hover:bg-muted'
      }`}
    >
      <svg viewBox="0 0 64 64" className="size-full" focusable="false">
        <path d={AGENT_AVATAR_SHAPES[shape]} fill={color} />
      </svg>
    </button>
  );
}

/** One selectable palette colour (the modal's colour row). */
export function AgentColorSwatch({
  id,
  hex,
  label,
  selected,
  onSelect,
}: {
  id: string;
  hex: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-color={id}
      aria-pressed={selected}
      aria-label={`Colour: ${label}`}
      title={label}
      onClick={onSelect}
      className={`size-7 rounded-full border-2 transition-transform ${
        selected ? 'border-primary scale-110' : 'border-transparent hover:scale-105'
      }`}
      style={{ backgroundColor: hex }}
    />
  );
}
