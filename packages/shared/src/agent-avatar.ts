/**
 * AGENT-AVATAR-UI: per-agent avatar config (v1 = shape + colour, no photo).
 *
 * The config lives on the agent record at `runtimeConfig.avatar` (jsonb — no migration).
 * A missing/invalid config means "default avatar": callers render today's initials circle,
 * so agents without a config never get a surprise rebrand.
 *
 * Shapes are organic blob paths on a 64x64 viewBox; colours are the fixed palette below.
 * Pure data + validation only (no React here).
 */

/** A chosen avatar: one blob shape id + one palette colour (hex). */
export interface AgentAvatarConfig {
  shape: AgentAvatarShapeId;
  color: string;
}

/** Shape ids, in grid order (first is the circle — closest to today's look). */
export const AGENT_AVATAR_SHAPE_IDS = ['circle', 'blob-1', 'blob-2', 'blob-3', 'blob-4', 'blob-5'] as const;
export type AgentAvatarShapeId = (typeof AGENT_AVATAR_SHAPE_IDS)[number];

/** Organic blob paths on a 64x64 viewBox (closed paths, filled with the palette colour). */
export const AGENT_AVATAR_SHAPES: Record<AgentAvatarShapeId, string> = {
  circle: 'M32 4 C47.5 4 60 16.5 60 32 C60 47.5 47.5 60 32 60 C16.5 60 4 47.5 4 32 C4 16.5 16.5 4 32 4 Z',
  'blob-1': 'M32 6 C46 6 58 16 58 32 C58 48 46 58 30 58 C14 58 6 46 6 30 C6 14 18 6 32 6 Z',
  'blob-2': 'M30 5 C48 3 59 18 57 34 C55 50 42 59 27 57 C12 55 5 41 7 26 C9 11 16 7 30 5 Z',
  'blob-3': 'M36 4 C52 8 61 22 56 38 C51 54 34 62 20 55 C6 48 3 30 11 17 C17 8 24 2 36 4 Z',
  'blob-4': 'M18 6 L46 6 C55 6 58 10 58 18 L58 46 C58 55 54 58 46 58 L18 58 C9 58 6 54 6 46 L6 18 C6 9 10 6 18 6 Z',
  'blob-5': 'M32 5 C50 9 59 25 55 41 C51 55 37 61 24 57 C10 52 4 37 9 23 C13 11 21 7 32 5 Z',
};

/** Palette entry: id, human label and the fill colour (lowercase hex). */
export interface AgentAvatarColor {
  id: string;
  label: string;
  hex: string;
}

/** Fixed colour row (v1). The first entry is the suggested default when the user first picks. */
export const AGENT_AVATAR_PALETTE: readonly AgentAvatarColor[] = [
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'emerald', label: 'Emerald', hex: '#10b981' },
  { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
  { id: 'rose', label: 'Rose', hex: '#f43f5e' },
  { id: 'amber', label: 'Amber', hex: '#f59e0b' },
  { id: 'teal', label: 'Teal', hex: '#14b8a6' },
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'slate', label: 'Slate', hex: '#64748b' },
];

const HEX_BY_ID = new Map(AGENT_AVATAR_PALETTE.map((c) => [c.id, c.hex]));
const HEXES = new Set(AGENT_AVATAR_PALETTE.map((c) => c.hex));
const SHAPES = new Set<string>(AGENT_AVATAR_SHAPE_IDS);

/**
 * Validate an untrusted avatar config (API body, stored jsonb). Both members must be from the
 * fixed sets (colour may be the palette id or its exact lowercase hex). Anything else returns
 * null — the caller falls back to the default avatar.
 */
export function parseAgentAvatarConfig(value: unknown): AgentAvatarConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shape = (value as { shape?: unknown }).shape;
  const color = (value as { color?: unknown }).color;
  if (typeof shape !== 'string' || !SHAPES.has(shape)) return null;
  if (typeof color !== 'string') return null;
  const hex = HEX_BY_ID.get(color) ?? color;
  if (!HEXES.has(hex)) return null;
  return { shape: shape as AgentAvatarShapeId, color: hex };
}

/** The agent's stored avatar from its runtimeConfig jsonb; null when unset or invalid. */
export function agentAvatarFromRuntimeConfig(runtimeConfig: unknown): AgentAvatarConfig | null {
  if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) return null;
  return parseAgentAvatarConfig((runtimeConfig as { avatar?: unknown }).avatar);
}
