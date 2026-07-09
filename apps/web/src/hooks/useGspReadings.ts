import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateGspReadingInput, UpdateGspReadingInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export const gspReadingsQueryKey = ['gspReadings'] as const;

/**
 * GET /api/gsp-readings — the signed-in user's standalone "set GSP without a
 * match" calibration readings (V17, all fighters; the GSP page filters per
 * fighter via `getGspEntries`).
 */
export function useGspReadings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: gspReadingsQueryKey,
    queryFn: () => api.gspReadings.list(),
    enabled: Boolean(user),
  });
}

/** POST /api/gsp-readings. Invalidates the readings query on success. */
export function useCreateGspReading() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGspReadingInput) => api.gspReadings.create(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gspReadingsQueryKey });
    },
  });
}

/** PATCH /api/gsp-readings/:id. Invalidates the readings query on success. */
export function useUpdateGspReading() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateGspReadingInput }) =>
      api.gspReadings.update(id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gspReadingsQueryKey });
    },
  });
}

/** DELETE /api/gsp-readings/:id. Invalidates the readings query on success. */
export function useDeleteGspReading() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.gspReadings.remove(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: gspReadingsQueryKey });
    },
  });
}
