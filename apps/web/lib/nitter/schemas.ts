import { z } from 'zod';

export const searchFiltersSchema = z
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

export const searchTweetsSchema = z.object({
  query: z.string().min(1),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minFaves: z.number().int().min(0).optional(),
  include: searchFiltersSchema,
  exclude: searchFiltersSchema,
});

export const feedUserSchema = z.object({
  username: z.string().min(1),
});

export const searchUsersSchema = z.object({
  query: z.string().min(1),
  cursor: z.string().min(1).optional(),
});
