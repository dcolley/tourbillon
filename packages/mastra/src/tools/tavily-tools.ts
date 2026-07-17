import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tracedAgentFetch } from './api-client';

const webSearchTavilyTool = createTool({
  id: 'webSearchTavily',
  description:
    'Search the web via Tavily (cloud API). Use for discovering sources, current events, and evidence. Returns titles, URLs, snippets, and an optional AI answer.',
  inputSchema: z.object({
    query: z.string().min(1).max(400).describe('Search query'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe('Maximum number of results to return'),
    searchDepth: z
      .preprocess(
        (val) => (val === '' || val === null ? undefined : val),
        z.enum(['basic', 'advanced']).optional().default('basic'),
      )
      .describe('basic is faster; advanced retrieves more comprehensive results'),
    includeAnswer: z
      .boolean()
      .optional()
      .default(true)
      .describe('Include a short AI-generated answer summarizing results'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'webSearchTavily',
      requestContext,
      '/api/tavily/search',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const TAVILY_TOOLS = {
  webSearchTavilyTool,
};

export const TAVILY_TOOL_IDS = Object.keys(TAVILY_TOOLS);
