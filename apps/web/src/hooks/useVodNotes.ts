import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type VodTimestampInput } from '@/lib/api';
import { matchesQueryKey } from './useMatches';

/**
 * Mutation hooks for the dedicated timestamp-note endpoints (Phase 8:
 * `POST/PATCH/DELETE /api/matches/:id/notes[/:noteId]`) — note writes no
 * longer ride the full-match PATCH (`useUpdateMatch`), so a match-fact edit
 * and a note write can never stomp each other.
 *
 * Every hook invalidates the `matches` query on success so the normalized
 * (id-bearing, seconds-sorted) read refetches — mirrors `useVodShares`'s
 * invalidation convention. Unlike `useUpdateMatch`, the `opponents` query is
 * NOT invalidated: a note write can never change an opponent name.
 */

/** POST /api/matches/:id/notes. Resolves with the created, id-bearing note. */
export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ matchId, input }: { matchId: string; input: VodTimestampInput }) =>
      api.matches.createNote(matchId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: matchesQueryKey });
    },
  });
}

/** PATCH /api/matches/:id/notes/:noteId — full-note replace by stable note id. */
export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      matchId,
      noteId,
      input,
    }: {
      matchId: string;
      noteId: string;
      input: VodTimestampInput;
    }) => api.matches.updateNote(matchId, noteId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: matchesQueryKey });
    },
  });
}

/** DELETE /api/matches/:id/notes/:noteId — removes one note by stable note id. */
export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ matchId, noteId }: { matchId: string; noteId: string }) =>
      api.matches.deleteNote(matchId, noteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: matchesQueryKey });
    },
  });
}

/**
 * POST /api/matches/:id/clear-vod — the one explicit "remove VOD" intent
 * (`MatchTable`'s "Remove VOD link" action). Drops `vodUrl`/
 * `vodStartSeconds`/`vodTimestamps` together; now that an unrelated
 * match-fact PATCH preserves notes on omission (Phase 8), this dedicated
 * endpoint is the only way to also clear the note subtree (RESEARCH
 * Pitfall 2).
 */
export function useClearVodAndNotes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (matchId: string) => api.matches.clearVod(matchId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: matchesQueryKey });
    },
  });
}
