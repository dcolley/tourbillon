import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tracedAgentFetch } from './api-client';

const searchFiltersSchema = z
  .object({
    nativeRetweets: z.boolean().optional(),
    media: z.boolean().optional(),
    videos: z.boolean().optional(),
    news: z.boolean().optional(),
    nativeVideo: z.boolean().optional(),
    replies: z.boolean().optional(),
    links: z.boolean().optional(),
    images: z.boolean().optional(),
    quote: z.boolean().optional(),
    spaces: z.boolean().optional(),
  })
  .optional();

const nitterSearchTweetsTool = createTool({
  id: 'nitterSearchTweets',
  description:
    'Search tweets via Nitter RSS. Supports date range, min likes, and include/exclude filters. Returns normalized JSON with tweet items.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query'),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Start date (YYYY-MM-DD)'),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('End date (YYYY-MM-DD)'),
    minFaves: z.number().int().min(0).optional().describe('Minimum likes'),
    include: searchFiltersSchema.describe('Include filters (f-*=on)'),
    exclude: searchFiltersSchema.describe('Exclude filters (e-*=on)'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'nitterSearchTweets',
      requestContext,
      '/api/nitter/search-tweets',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const nitterFeedUserTool = createTool({
  id: 'nitterFeedUser',
  description: "Fetch a user's recent tweets via Nitter RSS feed.",
  inputSchema: z.object({
    username: z.string().min(1).describe('Twitter/X username without @'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'nitterFeedUser',
      requestContext,
      '/api/nitter/feed-user',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const nitterSearchUsersTool = createTool({
  id: 'nitterSearchUsers',
  description: 'Search for X/Twitter users via Nitter HTML search.',
  inputSchema: z.object({
    query: z.string().min(1).describe('User search query'),
    cursor: z.string().min(1).optional().describe('Pagination cursor from a previous response'),
  }),
  execute: async (inputData, { requestContext }) => {
    const res = await tracedAgentFetch(
      'nitterSearchUsers',
      requestContext,
      '/api/nitter/search-users',
      { method: 'POST', body: JSON.stringify(inputData) },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const NITTER_TOOLS = {
  nitterSearchTweetsTool,
  nitterFeedUserTool,
  nitterSearchUsersTool,
};
