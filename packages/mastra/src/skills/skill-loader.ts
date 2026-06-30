import { readFile } from 'fs/promises';
import path from 'path';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { getAgentSkillsDir } from '@tourbillon/shared/company-workspace';

const SKILLS_DIR = path.join(process.cwd(), 'packages/skills');
const TEMPLATE_SKILLS_DIR = path.join(process.cwd(), 'packages/mastra/src/skills');

const TOOLSET_SKILL_FILES: Record<string, string> = {
  buffer: 'buffer-skills.md',
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
    const filePath = path.join(SKILLS_DIR, slug, 'SKILL.md');
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
    const content = await readFile(path.join(TEMPLATE_SKILLS_DIR, filename), 'utf-8');
    if (content.trim()) return { slug: toolsetId, content };
  } catch {
    // missing
  }

  return null;
}

export async function loadSkillsForAgent(
  agentRecord: AgentRecord
): Promise<Array<{ slug: string; content: string }>> {
  const assignedResults = await Promise.all(
    agentRecord.assignedSkills.map((slug) =>
      readSkillFile(slug, agentRecord.role)
    )
  );
  const assigned = assignedResults.filter(
    (r): r is { slug: string; content: string } => r !== null
  );

  const toolsets = agentRecord.assignedToolsets ?? [];
  const toolsetSkills: Array<{ slug: string; content: string }> = [];
  for (const [toolsetId, filename] of Object.entries(TOOLSET_SKILL_FILES)) {
    if (!toolsets.includes(toolsetId)) continue;
    const skill = await readToolsetSkill(agentRecord, toolsetId, filename);
    if (skill) toolsetSkills.push(skill);
  }

  const seen = new Set(assigned.map((s) => s.slug));
  const merged = [...assigned];
  for (const skill of toolsetSkills) {
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    merged.push(skill);
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
