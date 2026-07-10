import { createTool } from '@mastra/core/tools';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { extractToolRuntimeContext } from './api-client';
import {
  getSkillContentForAgent,
  listSkillCatalogForAgent,
} from '../skills/on-demand-skills';

async function loadAgentRecord(agentId: string | undefined) {
  if (!agentId) return null;
  return db.query.agents.findFirst({ where: eq(agents.id, agentId) });
}

export const listSkillsTool = createTool({
  id: 'listSkills',
  description:
    'List methodology skills assigned to you (slug + short description). ' +
    'Use getSkill(slug) to load a full skill body when you need its procedure. ' +
    'control-plane is already in your system prompt.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => {
    const { agentId } = extractToolRuntimeContext(requestContext);
    const agent = await loadAgentRecord(agentId);
    if (!agent) {
      return { error: 'agent_not_found', message: 'Could not resolve agent for listSkills' };
    }
    const catalog = await listSkillCatalogForAgent(agent);
    return {
      skills: catalog.map((s) => ({
        slug: s.slug,
        description: s.description,
        approxChars: s.approxChars,
        alreadyInSystemPrompt: s.alwaysInline,
      })),
    };
  },
});

export const getSkillTool = createTool({
  id: 'getSkill',
  description:
    'Load the full markdown body of an assigned skill by slug (from listSkills). ' +
    'Call before following methodology outside control-plane (e.g. plan-to-tasks, company playbooks).',
  inputSchema: z.object({
    slug: z.string().describe('Skill slug, e.g. plan-to-tasks or traders-corner'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { agentId } = extractToolRuntimeContext(requestContext);
    const agent = await loadAgentRecord(agentId);
    if (!agent) {
      return { error: 'agent_not_found', message: 'Could not resolve agent for getSkill' };
    }
    const skill = await getSkillContentForAgent(agent, inputData.slug);
    if (!skill) {
      const catalog = await listSkillCatalogForAgent(agent);
      return {
        error: 'skill_not_found',
        message: `No skill with slug "${inputData.slug}" assigned to this agent`,
        availableSlugs: catalog.map((s) => s.slug),
      };
    }
    return {
      slug: skill.slug,
      content: skill.content,
      chars: skill.content.length,
    };
  },
});

export const SKILL_TOOLS = {
  listSkillsTool,
  getSkillTool,
};
