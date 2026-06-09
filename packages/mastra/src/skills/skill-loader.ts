import { readFile } from 'fs/promises';
import path from 'path';
import type { Agent as AgentRecord } from '@paperclip-mastra/db';

const SKILLS_DIR = path.join(process.cwd(), 'packages/skills');

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

export async function loadSkillsForAgent(
  agentRecord: AgentRecord
): Promise<Array<{ slug: string; content: string }>> {
  const results = await Promise.all(
    agentRecord.assignedSkills.map((slug) =>
      readSkillFile(slug, agentRecord.role)
    )
  );
  return results.filter((r): r is { slug: string; content: string } => r !== null);
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
