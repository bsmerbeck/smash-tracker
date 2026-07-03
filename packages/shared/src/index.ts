import { z } from 'zod';

/**
 * Placeholder schema for Phase 1 scaffolding.
 * Real schemas (users, fighters, matches, opponents) derived from the
 * legacy RTDB data shape land in Phase 2.
 */
export const healthCheckSchema = z.object({
  status: z.literal('ok'),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;
