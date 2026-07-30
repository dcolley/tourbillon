import { readFile } from 'fs/promises';
import path from 'path';
import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  discoverAgentSkillFiles,
  getAgentSkillsDir,
  readAgentSkillFile,
  readCompanySkillFile,
} from '@tourbillon/shared/company-workspace';
import { getMonorepoRoot, resolveKnowledgeGraphMounts, CONTROL_PLANE_SKILL_SLUG, type AgentRuntimeConfig } from '@tourbillon/shared';

/** Bundled methodology skills — always resolve from repo root, not process.cwd(). */
function getBundledSkillsDir(): string {
  const fromEnv = process.env.SKILLS_DIR?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(getMonorepoRoot(), fromEnv.replace(/^\.\//, ''));
  }
  return path.join(getMonorepoRoot(), 'packages/skills');
}

function getToolsetSkillsTemplateDir(): string {
  return path.join(getMonorepoRoot(), 'packages/mastra/src/skills');
}

const TOOLSET_SKILL_FILES: Record<string, string> = {
  buffer: 'buffer-skills.md',
  'code-execution': 'code-execution-skills.md',
  'knowledge-graph': 'knowledge-graph-skills.md',
};

// Sections only relevant to CEO/admin role — stripped for other agents
const CEO_ONLY_SECTION_HEADERS = [
  '## Company Skills Workflow',
  '## Setting Agent Instructions Path',
  '## Company Import / Export',
  '## Self-Test Playbook',
];

export async function readSkillFile(
  slug: string,
  agentRole?: string
): Promise<{ slug: string; content: string } | null> {
  try {
    const filePath = path.join(getBundledSkillsDir(), slug, 'SKILL.md');
    let content = await readFile(filePath, 'utf-8');

    // Strip CEO-only sections for non-CEO agents (~30% token reduction)
    if (agentRole && agentRole !== 'ceo') {
      for (const header of CEO_ONLY_SECTION_HEADERS) {
        content = stripSection(content, header);
      }
    }

    return { slug, content };
  } catch {
    return null;
  }
}

async function resolveAssignedSkill(
  agentRecord: AgentRecord,
  slug: string,
): Promise<{ slug: string; content: string } | null> {
  const companyContent = await readCompanySkillFile(agentRecord.companyId, slug);
  if (companyContent) {
    return { slug, content: companyContent };
  }

  return readSkillFile(slug, agentRecord.role);
}

async function readToolsetSkill(
  agentRecord: AgentRecord,
  toolsetId: string,
  filename: string,
): Promise<{ slug: string; content: string } | null> {
  const workspacePath = path.join(
    getAgentSkillsDir(agentRecord.companyId, agentRecord.urlKey),
    filename,
  );
  try {
    const content = await readFile(workspacePath, 'utf-8');
    if (content.trim()) return { slug: toolsetId, content };
  } catch {
    // fall through to repo template
  }

  try {
    const content = await readFile(path.join(getToolsetSkillsTemplateDir(), filename), 'utf-8');
    if (content.trim()) return { slug: toolsetId, content };
  } catch {
    // missing
  }

  return null;
}

async function loadDynamicAgentSkills(
  agentRecord: AgentRecord,
): Promise<Array<{ slug: string; content: string }>> {
  const refs = await discoverAgentSkillFiles(agentRecord.companyId, agentRecord.urlKey);
  const skills: Array<{ slug: string; content: string }> = [];

  for (const ref of refs) {
    const content = await readAgentSkillFile(agentRecord.companyId, agentRecord.urlKey, ref.filename);
    if (content) skills.push({ slug: ref.slug, content });
  }

  return skills;
}

export async function loadSkillsForAgent(
  agentRecord: AgentRecord
): Promise<Array<{ slug: string; content: string }>> {
  const skillMap = new Map<string, string>();

  // control-plane is baked into every agent — load first, independent of assignedSkills.
  // Company workspace override still wins via resolveAssignedSkill.
  const controlPlane = await resolveAssignedSkill(agentRecord, CONTROL_PLANE_SKILL_SLUG);
  if (controlPlane) {
    skillMap.set(CONTROL_PLANE_SKILL_SLUG, controlPlane.content);
  } else {
    const bundled = await readSkillFile(CONTROL_PLANE_SKILL_SLUG, agentRecord.role);
    if (bundled) skillMap.set(CONTROL_PLANE_SKILL_SLUG, bundled.content);
  }

  for (const slug of agentRecord.assignedSkills) {
    if (slug === CONTROL_PLANE_SKILL_SLUG) continue;
    const skill = await resolveAssignedSkill(agentRecord, slug);
    if (skill) {
      skillMap.set(skill.slug, skill.content);
    }
  }

  const dynamicAgentSkills = await loadDynamicAgentSkills(agentRecord);
  for (const skill of dynamicAgentSkills) {
    // Never let a dynamic file drop control-plane; allow same-slug override only.
    skillMap.set(skill.slug, skill.content);
  }

  // Re-assert after dynamic merge in case a bad override cleared it.
  if (!skillMap.has(CONTROL_PLANE_SKILL_SLUG)) {
    const bundled = await readSkillFile(CONTROL_PLANE_SKILL_SLUG, agentRecord.role);
    if (bundled) skillMap.set(CONTROL_PLANE_SKILL_SLUG, bundled.content);
  }

  const merged = Array.from(skillMap.entries()).map(([slug, content]) => ({ slug, content }));

  const toolsets = agentRecord.assignedToolsets ?? [];
  const seen = new Set(merged.map((s) => s.slug));
  for (const [toolsetId, filename] of Object.entries(TOOLSET_SKILL_FILES)) {
    if (!toolsets.includes(toolsetId)) continue;
    if (seen.has(toolsetId)) continue;
    const skill = await readToolsetSkill(agentRecord, toolsetId, filename);
    if (skill) {
      seen.add(skill.slug);
      if (toolsetId === 'knowledge-graph') {
        const mounts = resolveKnowledgeGraphMounts(
          agentRecord.runtimeConfig as AgentRuntimeConfig,
        );
        const mountLines = [
          '## Enabled mounts (this agent)',
          '',
          `- Private memory (\`agents/${agentRecord.urlKey}/memory.jsonl\`): **${mounts.private ? 'on' : 'off'}**`,
          `- Company memory (\`memory.jsonl\`): **${mounts.company ? 'on' : 'off'}**`,
          '',
          mounts.private && mounts.company
            ? 'Use the matching tool namespace (`memory_private_*` vs `memory_company_*`) for each write.'
            : mounts.private
              ? 'Only private memory is mounted — use private tools exclusively.'
              : mounts.company
                ? 'Only company memory is mounted — use company tools exclusively.'
                : 'No memory mounts enabled — knowledge-graph tools will be unavailable.',
          '',
        ].join('\n');
        merged.push({ slug: skill.slug, content: `${mountLines}\n${skill.content}` });
      } else {
        merged.push(skill);
      }
    }
  }

  return merged;
}

function stripSection(markdown: string, header: string): string {
  const level = (header.match(/^(#+)/) ?? ['', '##'])[1].length;
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedHeader}[\\s\\S]*?(?=\\n#{1,${level}} |$)`,
    'g'
  );
  return markdown.replace(pattern, '');
}
