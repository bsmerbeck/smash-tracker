import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertOpponentNoteInput } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import { subjectScope } from '@/lib/subjectQueryKey';
import { useActiveSubject, type ActiveSubject } from './useActiveSubject';
import { useAuth } from './useAuth';

/** TEN-04: subject-scoped so Personal/Client A/Client B scouting notes never share a cache entry. */
export function opponentNotesQueryKey(subject: ActiveSubject) {
  return [...subjectScope(subject), 'opponentNotes'] as const;
}

/**
 * GET /api/opponent-notes — the active subject's scouting notes, keyed by
 * canonical opponent name. Same "treat loading as empty" contract as
 * `useOpponentAliases`: callers shouldn't gate the scouting report's render
 * on this loading, since notes are supplementary to the stats-driven report.
 */
export function useOpponentNotes() {
  const { user } = useAuth();
  const subject = useActiveSubject();
  return useQuery({
    queryKey: opponentNotesQueryKey(subject),
    queryFn: () => api.opponents.notes.list(),
    enabled: Boolean(user),
  });
}

/** PUT /api/opponent-notes/:name. Invalidates the notes map on success. */
export function useUpsertOpponentNote() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: ({ name, input }: { name: string; input: UpsertOpponentNoteInput }) =>
      api.opponents.notes.upsert(name, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opponentNotesQueryKey(subject) });
    },
  });
}

/** DELETE /api/opponent-notes/:name. Invalidates the notes map on success. */
export function useDeleteOpponentNote() {
  const queryClient = useQueryClient();
  const subject = useActiveSubject();
  return useMutation({
    mutationFn: (name: string) => api.opponents.notes.remove(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: opponentNotesQueryKey(subject) });
    },
  });
}
