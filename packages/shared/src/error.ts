import { z } from 'zod';

/**
 * Standard error response envelope used by apps/api for 400/404/500s.
 * `details` carries zod issue data for validation failures; omitted
 * otherwise so internals aren't leaked.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
