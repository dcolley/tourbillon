import { z } from 'zod';

export const tavilySearchSchema = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).optional().default(5),
  searchDepth: z.preprocess(
    (val) => (val === '' || val === null ? undefined : val),
    z.enum(['basic', 'advanced']).optional().default('basic'),
  ),
  includeAnswer: z.boolean().optional().default(true),
});

export type TavilySearchInput = z.infer<typeof tavilySearchSchema>;
