/**
 * On-demand skill loading: keep a small always-inline set in the system prompt;
 * expose the rest as a catalog + getSkill / listSkills tools so large playbooks
 * (e.g. Traders Corner) do not consume the context window every wake.
 */
import type { Agent as AgentRecord } from '@tourbillon/db';
import { loadSkillsForAgent } from './skill-loader';

/** Skills whose full body is injected into the system prompt every wake. */
export const ALWAYS_INLINE_SKILL_SLUGS = new Set(['control-plane']);

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

  return { alwaysInline, catalog };
}

export function formatSkillsCatalogSection(catalog: SkillCatalogEntry[]): string {
  if (catalog.length === 0) {
    return '';
  }

  const lines = [
    '## Available Skills (on demand)',
    '',
    'Only skills marked always-inline are fully included above. For the rest, call `listSkills` or `getSkill` before following that methodology.',
    'Do not guess skill contents — load them when needed.',
    '',
  ];

  for (const entry of catalog) {
    const tag = entry.alwaysInline ? ' [already in system prompt]' : '';
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
