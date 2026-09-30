import { useMemo, useState } from 'react';
import {
  resolveEntryTiers,
  trimmedEventKey,
  type Match,
  type TierResolution,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useInsightDismissals } from '@/hooks/useInsightDismissals';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { entryDisplayDateRange, isAdminImportedEntry } from '@/lib/historicalTournament';
import { FOURTEEN_DAYS_MS } from '@/lib/prepEntryPoints';

/**
 * The own-account registry row behind a recap, with its resolved tier. Present ONLY for the
 * own account (D-17): under `/coach/:clientId/*` and `/workspace/:tenantId/*` the viewer's own
 * registry is never read, so a client's recap can never carry the viewer's tier or placement.
 */
export interface RecapEntry {
  entry: TournamentEntry;
  /** The routable key, or `null` for a row the registry holds without one. */
  entryKey: string | null;
  resolution: TierResolution;
  /** An admin-imported historical row: no debrief door is ever offered for it. */
  isAdminImported: boolean;
}

export interface RecapCandidate {
  /** The event's trimmed key (`eventName ?? tournamentName`), the same rule the template groups by. */
  eventKey: string;
  /** The event's games, from the SUBJECT's matches only. */
  games: Match[];
  newestGameAt: number;
  /** When the event ended: the registry's display end when one is known, else its newest game. */
  endMs: number;
  /** `recap:<entryKey ?? eventKey>`: the id in the device-local dismissal store, independent of any horizon. */
  dismissalId: string;
  entry: RecapEntry | null;
}

/** `loading`: the own-account registry is still resolving for an event that may qualify. */
export type RecapStatus = 'loading' | 'none' | 'ready';

export interface RecapCandidateResult {
  status: RecapStatus;
  candidate: RecapCandidate | null;
  dismiss: () => void;
}

export interface UseRecapCandidateInput {
  /**
   * The digest's mount-frozen `lastSeenAt` (`null` on a first visit on this device, when any
   * event qualifies). Mark as read on the digest does not move it.
   */
  lastSeenAt: number | null;
  /** The digest's snapshot has been read; until then nothing is decided. */
  ready: boolean;
  /** False when the page is not showing the card (no fighters chosen): nothing is selected. */
  enabled?: boolean;
}

const NO_CANDIDATE: RecapCandidateResult = { status: 'none', candidate: null, dismiss: () => {} };

/** The dismissal id for a recap: the entry key when the registry has one, else the event key. */
export function recapDismissalId(entryKey: string | null, eventKey: string): string {
  return `recap:${entryKey ?? eventKey}`;
}

/** The event with the newest game among the subject's named events, with all of its games; `null` when no game names an event. */
export function selectNewestEvent(
  matches: readonly Match[],
): { eventKey: string; games: Match[]; newestGame: Match } | null {
  let newest: Match | null = null;
  let newestKey: string | null = null;
  for (const match of matches) {
    const key = trimmedEventKey(match);
    if (key === null) continue;
    if (newest === null || match.time > newest.time) {
      newest = match;
      newestKey = key;
    }
  }
  if (newest === null || newestKey === null) return null;
  const games = matches.filter((match) => trimmedEventKey(match) === newestKey);
  return { eventKey: newestKey, games, newestGame: newest };
}

/**
 * D-12 as amended by D-18: the newest event shows its recap when it is complete, its end is
 * within the last fourteen days (a DATE test on the shared `FOURTEEN_DAYS_MS`, never the
 * server's debrief window), its games are newer than the frozen `lastSeenAt`, and it has not
 * been dismissed on this device. Pure.
 */
export function evaluateRecapCandidate(input: {
  event: { eventKey: string; games: Match[]; newestGame: Match };
  lastSeenAt: number | null;
  nowMs: number;
  dismissedIds: readonly string[];
  entry: RecapEntry | null;
}): RecapCandidate | null {
  const { event, lastSeenAt, nowMs, dismissedIds, entry } = input;
  const newestGameAt = event.newestGame.time;
  if (lastSeenAt !== null && newestGameAt <= lastSeenAt) return null;
  const endMs = (entry ? entryDisplayDateRange(entry.entry)?.endMs : undefined) ?? newestGameAt;
  if (endMs > nowMs) return null;
  if (nowMs - endMs > FOURTEEN_DAYS_MS) return null;
  const dismissalId = recapDismissalId(entry?.entryKey ?? null, event.eventKey);
  if (dismissedIds.includes(dismissalId)) return null;
  return {
    eventKey: event.eventKey,
    games: event.games,
    newestGameAt,
    endMs,
    dismissalId,
    entry,
  };
}

/** The shared reads both subject paths need: the subject's games, its dismissals and one clock. */
function useRecapInputs({ lastSeenAt, ready, enabled = true }: UseRecapCandidateInput) {
  const { allMatches } = useFilteredMatches();
  const dismissals = useInsightDismissals();
  // The clock is read once (the React Compiler forbids a bare `Date.now()` in the render body).
  const [nowMs] = useState(() => Date.now());
  const event = useMemo(
    () => (ready && enabled ? selectNewestEvent(allMatches) : null),
    [allMatches, ready, enabled],
  );
  return { allMatches, dismissals, nowMs, event, lastSeenAt };
}

function finish(
  candidate: RecapCandidate | null,
  dismiss: (id: string) => void,
): RecapCandidateResult {
  if (candidate === null) return NO_CANDIDATE;
  return { status: 'ready', candidate, dismiss: () => dismiss(candidate.dismissalId) };
}

/**
 * The recap source for a coach or workspace subject (D-17, F3b): the candidate derives from the
 * subject's matches ONLY. This module's own-account sibling reads the viewer's registry through
 * `useTournamentEntries`; this one never does, so no tier, placement or registry entry can
 * reach a client's card. Hooks stay unconditional because `RecapCandidateGate` selects between
 * the two at the component level.
 */
export function useSubjectRecapCandidate(input: UseRecapCandidateInput): RecapCandidateResult {
  const { dismissals, nowMs, event, lastSeenAt } = useRecapInputs(input);
  const candidate = useMemo(
    () =>
      event
        ? evaluateRecapCandidate({
            event,
            lastSeenAt,
            nowMs,
            dismissedIds: dismissals.dismissedIds,
            entry: null,
          })
        : null,
    [event, lastSeenAt, nowMs, dismissals.dismissedIds],
  );
  return finish(candidate, dismissals.dismiss);
}

/**
 * The own-account recap source: the same selection, enriched with the registry row whose
 * attributed games include the event's newest game (the one shared `resolveEntryTiers` the
 * Tournaments page resolves with, so the card and the table can never disagree on a tier).
 * While the registry is still pending and an event could qualify the status is `loading`, so
 * the Dashboard can hold the recap's cell instead of resizing the digest when it lands. A
 * failed registry read degrades to the matches-only candidate.
 */
export function useOwnAccountRecapCandidate(input: UseRecapCandidateInput): RecapCandidateResult {
  const { allMatches, dismissals, nowMs, event, lastSeenAt } = useRecapInputs(input);
  const entriesQuery = useTournamentEntries();
  const entries = entriesQuery.data;
  const entriesPending = entriesQuery.isPending;

  const entry = useMemo<RecapEntry | null>(() => {
    if (!event || !entries) return null;
    const resolved = resolveEntryTiers(entries, allMatches);
    const index = resolved.findIndex((item) =>
      item.matches.some((match) => match.id === event.newestGame.id),
    );
    const item = index >= 0 ? resolved[index] : undefined;
    const source = index >= 0 ? entries[index] : undefined;
    if (!item || !source) return null;
    return {
      entry: source,
      entryKey: source.entryKey ?? null,
      resolution: item.resolution,
      isAdminImported: isAdminImportedEntry(source),
    };
  }, [event, entries, allMatches]);

  const candidate = useMemo(
    () =>
      event && !entriesPending
        ? evaluateRecapCandidate({
            event,
            lastSeenAt,
            nowMs,
            dismissedIds: dismissals.dismissedIds,
            entry,
          })
        : null,
    [event, entriesPending, lastSeenAt, nowMs, dismissals.dismissedIds, entry],
  );

  if (event && entriesPending) {
    // Could this event qualify once the registry lands? The registry's end is never earlier than
    // the newest game, so a game newer than last seen and inside the window is the cheap test.
    const newestGameAt = event.newestGame.time;
    const possible =
      (lastSeenAt === null || newestGameAt > lastSeenAt) &&
      newestGameAt <= nowMs &&
      nowMs - newestGameAt <= FOURTEEN_DAYS_MS;
    return possible ? { status: 'loading', candidate: null, dismiss: () => {} } : NO_CANDIDATE;
  }
  return finish(candidate, dismissals.dismiss);
}
