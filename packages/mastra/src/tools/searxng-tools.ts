import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tracedAgentFetch } from './api-client';

const searxngTimeRangeSchema = z.preprocess(
  (val) => (val === '' || val === null ? undefined : val),
  z.enum(['day', 'week', 'month', 'year']).optional(),
);

const searxngSearchTool = createTool({
  id: 'searxngSearch',
  description:
    'Search the web via local SearXNG (JSON API). Use for discovering sources, current events, and evidence. Returns titles, URLs, and snippets.',
  inputSchema: z.object({
    query: z.string().min(1).max(400).describe('Search query'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(10)
      .describe('Maximum number of results to return'),
    categories: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        if (Array.isArray(val)) return val.join(',');
        return val;
      })
      .describe('SearXNG categories, e.g. general, news, science (comma-separated)'),
    language: z
      .preprocess((val) => (val === '' || val === null ? undefined : val), z.string().optional())
      .describe('Language code, e.g. en, en-GB'),
    timeRange: searxngTimeRangeSchema.describe('Limit results to a recent time range'),
    safesearch: z
      .number()
      .int()
      .min(0)
      .max(2)
      .optional()
      .describe('0=off, 1=moderate, 2=strict'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'searxngSearch',
      requestContext,
      '/api/searxng/search',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const searxngNewsSearchTool = createTool({
  id: 'searxngNewsSearch',
  description:
    'Search recent news via SearXNG (news category). Use for breaking stories and time-sensitive coverage.',
  inputSchema: z.object({
    query: z.string().min(1).max(400).describe('News search query'),
    maxResults: z.number().int().min(1).max(30).optional().default(10),
    language: z
      .preprocess((val) => (val === '' || val === null ? undefined : val), z.string().optional()),
    timeRange: z
      .preprocess(
        (val) => (val === '' || val === null ? undefined : val),
        z.enum(['day', 'week', 'month', 'year']).optional().default('week'),
      )
      .describe('Time range for news results'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'searxngNewsSearch',
      requestContext,
      '/api/searxng/news-search',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const SEARXNG_TOOLS = {
  searxngSearchTool,
  searxngNewsSearchTool,
};

export const SEARXNG_TOOL_IDS = Object.keys(SEARXNG_TOOLS);
