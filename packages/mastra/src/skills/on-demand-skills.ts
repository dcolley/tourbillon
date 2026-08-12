/**
 * On-demand skill loading: keep a small always-inline set in the system prompt;
 * expose the rest as a catalog + getSkill / listSkills tools so large playbooks
 * (e.g. Traders Corner) do not consume the context window every wake.
 */
import type { Agent as AgentRecord } from '@tourbillon/db';
import { CONTROL_PLANE_SKILL_SLUG } from '@tourbillon/shared';
import { loadSkillsForAgent, readSkillFile } from './skill-loader';

/** Skills whose full body is injected into the system prompt every wake. */
export const ALWAYS_INLINE_SKILL_SLUGS = new Set([CONTROL_PLANE_SKILL_SLUG]);

export interface SkillCatalogEntry {
  slug: string;
  description: string;
  approxChars: number;
  alwaysInline: boolean;
}

export interface PreparedAgentSkills {
  alwaysInline: Array<{ slug: string; content: string }>;
  catalog: SkillCatalogEntry[];
}

export function extractSkillDescription(content: string, maxLen = 240): string {
  const withoutTitle = content.replace(/^#[^\n]*\n+/, '');
  const para = withoutTitle.split(/\n\n+/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!para) return 'Methodology skill — call getSkill to load full instructions.';
  return para.length > maxLen ? `${para.slice(0, maxLen - 1)}…` : para;
}

export type PrepareAgentSkillsMode = 'heartbeat' | 'chat';

export interface PrepareAgentSkillsOptions {
  /**
   * `heartbeat` (default): force-inline control-plane.
   * `chat`: catalog only — never inline control-plane (interactive dashboard chat).
   */
  mode?: PrepareAgentSkillsMode;
}

export async function prepareAgentSkills(
  agentRecord: AgentRecord,
  options?: PrepareAgentSkillsOptions,
): Promise<PreparedAgentSkills> {
  const mode = options?.mode ?? 'heartbeat';
  const all = await loadSkillsForAgent(agentRecord);
  const alwaysInline: PreparedAgentSkills['alwaysInline'] = [];
  const catalog: SkillCatalogEntry[] = [];

  for (const skill of all) {
    const always =
      mode === 'heartbeat' && ALWAYS_INLINE_SKILL_SLUGS.has(skill.slug);
    if (always) {
      alwaysInline.push(skill);
    }
    catalog.push({
      slug: skill.slug,
      description: extractSkillDescription(skill.content),
      approxChars: skill.content.length,
      alwaysInline: always,
    });
  }

  if (mode === 'heartbeat') {
    // Hard guarantee: every agent gets control-plane inlined in the system prompt.
    if (!alwaysInline.some((s) => s.slug === CONTROL_PLANE_SKILL_SLUG)) {
      const bundled = await readSkillFile(CONTROL_PLANE_SKILL_SLUG, agentRecord.role);
      if (!bundled) {
        throw new Error(
          `Failed to load baked-in skill "${CONTROL_PLANE_SKILL_SLUG}" for agent ${agentRecord.urlKey}`,
        );
      }
      alwaysInline.unshift(bundled);
      if (!catalog.some((c) => c.slug === CONTROL_PLANE_SKILL_SLUG)) {
        catalog.unshift({
          slug: bundled.slug,
          description: extractSkillDescription(bundled.content),
          approxChars: bundled.content.length,
          alwaysInline: true,
        });
      }
    }
  } else if (!catalog.some((c) => c.slug === CONTROL_PLANE_SKILL_SLUG)) {
    // Chat may still load control-plane via getSkill for Q&A — never as a wake ritual.
    const bundled = await readSkillFile(CONTROL_PLANE_SKILL_SLUG, agentRecord.role);
    if (bundled) {
      catalog.unshift({
        slug: bundled.slug,
        description: extractSkillDescription(bundled.content),
        approxChars: bundled.content.length,
        alwaysInline: false,
      });
    }
  }

  return { alwaysInline, catalog };
}

export function formatSkillsCatalogSection(
  catalog: SkillCatalogEntry[],
  options?: { mode?: PrepareAgentSkillsMode },
): string {
  if (catalog.length === 0) {
    return '';
  }

  const mode = options?.mode ?? 'heartbeat';
  const lines = [
    '## Available Skills (on demand)',
    '',
  ];

  if (mode === 'heartbeat') {
    lines.push(
      `\`${CONTROL_PLANE_SKILL_SLUG}\` (Control Plane Operations) is baked into every agent and already fully included above — follow it on every wake. Do not call getSkill for it.`,
      'For other skills, call `listSkills` or `getSkill` before following that methodology.',
    );
  } else {
    lines.push(
      'You are in dashboard **chat** mode — not a heartbeat. Do not run the control-plane checkout/inbox/EXIT loop.',
      'Call `listSkills` or `getSkill` before following any methodology skill.',
    );
  }

  lines.push('Do not guess skill contents — load them when needed.', '');

  for (const entry of catalog) {
    const tag = entry.alwaysInline ? ' [baked into system prompt]' : '';
    lines.push(
      `- **${entry.slug}** (~${entry.approxChars} chars)${tag}: ${entry.description}`,
    );
  }

  return lines.join('\n');
}

/** Compact skills catalog for chat — fewer tokens than the full heartbeat listing. */
export function formatChatSkillsCatalogSection(catalog: SkillCatalogEntry[]): string {
  if (catalog.length === 0) return '';

  const lines = [
    '## Skills (on demand)',
    '',
    'Call `getSkill(slug)` before following methodology. Chat mode — no heartbeat EXIT loop.',
    '',
  ];

  const maxEntries = 12;
  for (const entry of catalog.slice(0, maxEntries)) {
    const short =
      entry.description.length > 100
        ? `${entry.description.slice(0, 99)}…`
        : entry.description;
    lines.push(`- \`${entry.slug}\` — ${short}`);
  }
  if (catalog.length > maxEntries) {
    lines.push(`- …and ${catalog.length - maxEntries} more (use \`listSkills\`)`);
  }

  return lines.join('\n');
}

export async function getSkillContentForAgent(
  agentRecord: AgentRecord,
  slug: string,
): Promise<{ slug: string; content: string } | null> {
  const all = await loadSkillsForAgent(agentRecord);
  const match = all.find((s) => s.slug === slug);
  return match ?? null;
}

export async function listSkillCatalogForAgent(
  agentRecord: AgentRecord,
): Promise<SkillCatalogEntry[]> {
  const prepared = await prepareAgentSkills(agentRecord);
  return prepared.catalog;
}
