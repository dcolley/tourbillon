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

export async function prepareAgentSkills(agentRecord: AgentRecord): Promise<PreparedAgentSkills> {
  const all = await loadSkillsForAgent(agentRecord);
  const alwaysInline: PreparedAgentSkills['alwaysInline'] = [];
  const catalog: SkillCatalogEntry[] = [];

  for (const skill of all) {
    const always = ALWAYS_INLINE_SKILL_SLUGS.has(skill.slug);
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

  return { alwaysInline, catalog };
}

export function formatSkillsCatalogSection(catalog: SkillCatalogEntry[]): string {
  if (catalog.length === 0) {
    return '';
  }

  const lines = [
    '## Available Skills (on demand)',
    '',
    `\`${CONTROL_PLANE_SKILL_SLUG}\` (Control Plane Operations) is baked into every agent and already fully included above — follow it on every wake. Do not call getSkill for it.`,
    'For other skills, call `listSkills` or `getSkill` before following that methodology.',
    'Do not guess skill contents — load them when needed.',
    '',
  ];

  for (const entry of catalog) {
    const tag = entry.alwaysInline ? ' [baked into system prompt]' : '';
    lines.push(
      `- **${entry.slug}** (~${entry.approxChars} chars)${tag}: ${entry.description}`,
    );
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
