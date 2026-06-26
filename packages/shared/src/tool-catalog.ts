import type { AgentRuntimeConfig } from './types';

export type ToolCapability = 'read' | 'write';

export interface GranularToolDefinition {
  id: string;
  label: string;
  description: string;
  capability: ToolCapability;
}

export interface GranularToolGroup {
  id: string;
  label: string;
  tools: readonly GranularToolDefinition[];
}

export const GRANULAR_TOOL_GROUPS = [
  {
    id: 'goal-management',
    label: 'Goal management',
    tools: [
      {
        id: 'listGoals',
        capability: 'read',
        label: 'List goals',
        description: 'List company goals with issue stats and needsAttention flag.',
      },
      {
        id: 'getGoalDetail',
        capability: 'read',
        label: 'Goal detail',
        description: 'Full goal context: description, linked issues, and stats.',
      },
      {
        id: 'createGoal',
        capability: 'write',
        label: 'Create goal',
        description: 'Create a new company goal.',
      },
      {
        id: 'updateGoal',
        capability: 'write',
        label: 'Update goal',
        description: 'Update goal title, description, status, or owner.',
      },
    ],
  },
  {
    id: 'project-management',
    label: 'Project management',
    tools: [
      {
        id: 'listProjects',
        capability: 'read',
        label: 'List projects',
        description: 'List projects with optional goal filter.',
      },
      {
        id: 'getProjectDetail',
        capability: 'read',
        label: 'Project detail',
        description: 'Project context with linked issues and stats.',
      },
      {
        id: 'createProject',
        capability: 'write',
        label: 'Create project',
        description: 'Create a project under a goal.',
      },
      {
        id: 'updateProject',
        capability: 'write',
        label: 'Update project',
        description: 'Update project title, description, status, goal, or owner.',
      },
    ],
  },
  {
    id: 'issue-management',
    label: 'Issue management',
    tools: [
      {
        id: 'createIssue',
        capability: 'write',
        label: 'Create issue',
        description: 'Create a top-level issue linked to a goal.',
      },
      {
        id: 'putPlanDocument',
        capability: 'write',
        label: 'Plan document',
        description: 'Create or update the plan document on an issue.',
      },
      {
        id: 'requestConfirmation',
        capability: 'write',
        label: 'Request confirmation',
        description: 'Pause for a yes/no board decision on an issue.',
      },
    ],
  },
] as const satisfies readonly GranularToolGroup[];

export const ALL_ASSIGNABLE_TOOL_IDS = GRANULAR_TOOL_GROUPS.flatMap((g) =>
  g.tools.map((t) => t.id),
);

export const VALID_ASSIGNABLE_TOOL_IDS = new Set<string>(ALL_ASSIGNABLE_TOOL_IDS);

/** Issue-management tools granted by legacy `planning` toolset. */
export const LEGACY_PLANNING_ISSUE_TOOLS = [
  'createIssue',
  'putPlanDocument',
  'requestConfirmation',
] as const;

const PLANNER_ROLES = new Set(['ceo', 'cto', 'pm']);

export const ROLE_DEFAULT_ASSIGNED_TOOLS: Record<string, string[]> = {
  ceo: [...ALL_ASSIGNABLE_TOOL_IDS],
  cto: [...ALL_ASSIGNABLE_TOOL_IDS],
  pm: [...ALL_ASSIGNABLE_TOOL_IDS],
  engineer: [
    'listGoals',
    'getGoalDetail',
    'listProjects',
    'getProjectDetail',
    'createIssue',
    'putPlanDocument',
  ],
  qa: [
    'listGoals',
    'getGoalDetail',
    'listProjects',
    'getProjectDetail',
    'createIssue',
    'putPlanDocument',
  ],
  designer: [
    'listGoals',
    'getGoalDetail',
    'listProjects',
    'getProjectDetail',
    'createIssue',
    'putPlanDocument',
  ],
  custom: [],
};

export interface AssignedToolsAgentLike {
  role: string;
  assignedToolsets?: string[] | null;
  runtimeConfig?: AgentRuntimeConfig | null;
}

/**
 * Resolve enabled granular tool ids for an agent.
 * Order: stored runtimeConfig.assignedTools → legacy planning toolset → role defaults.
 */
export function resolveAssignedTools(agent: AssignedToolsAgentLike): string[] {
  const stored = agent.runtimeConfig?.assignedTools;
  if (stored !== undefined) {
    return stored.filter((id) => VALID_ASSIGNABLE_TOOL_IDS.has(id));
  }

  const toolsets = agent.assignedToolsets ?? [];
  if (toolsets.includes('planning')) {
    if (PLANNER_ROLES.has(agent.role)) {
      return [...ALL_ASSIGNABLE_TOOL_IDS];
    }
    return [...LEGACY_PLANNING_ISSUE_TOOLS];
  }

  return ROLE_DEFAULT_ASSIGNED_TOOLS[agent.role] ?? [];
}

export function hasExplicitAssignedTools(agent: AssignedToolsAgentLike): boolean {
  return agent.runtimeConfig?.assignedTools !== undefined;
}
