import { z } from 'zod';

export const searxngTimeRangeSchema = z.preprocess(
  (val) => (val === '' || val === null ? undefined : val),
  z.enum(['day', 'week', 'month', 'year']).optional(),
);

export const searxngSearchSchema = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(30).optional().default(10),
  categories: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (Array.isArray(val)) return val.join(',');
      return val;
    }),
  language: z.preprocess(
    (val) => (val === '' || val === null ? undefined : val),
    z.string().optional(),
  ),
  timeRange: searxngTimeRangeSchema,
  safesearch: z.number().int().min(0).max(2).optional(),
});

export const searxngNewsSearchSchema = z.object({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(30).optional().default(10),
  language: z.preprocess(
    (val) => (val === '' || val === null ? undefined : val),
    z.string().optional(),
  ),
  timeRange: z.preprocess(
    (val) => (val === '' || val === null ? undefined : val),
    z.enum(['day', 'week', 'month', 'year']).optional().default('week'),
  ),
});

export type SearxngSearchInput = z.infer<typeof searxngSearchSchema>;
export type SearxngNewsSearchInput = z.infer<typeof searxngNewsSearchSchema>;
