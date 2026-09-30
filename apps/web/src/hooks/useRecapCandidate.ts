import { useMemo, useState } from 'react';
import {
  hasEventSyncedSince,
  newestEventBlock,
  resolveEntryTiers,
  type DigestSeenEvents,
  type EventBlock,
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
  /**
   * 39.2-REVIEW WEB-CR-01: the entry's OWN attributed games from the one shared resolution
   * (`resolveEntryTiers`), which the card reads instead of any name-grouped set.
   */
  games: Match[];
}

export interface RecapCandidate {
  /** The event's display name (`eventName ?? tournamentName`, trimmed). Never its identity. */
  eventKey: string;
  /**
   * 39.2-REVIEW WEB-CR-01: the event's identity — its proximity block's key (event name,
   * tournament name, first game) — so two same-named brackets are never one event.
   */
  eventId: string;
  /** The event's games, from the SUBJECT's matches only: the registry entry's own when one matched. */
  games: Match[];
  newestGameAt: number;
  /** When the event ended: the registry's display end when one is known, else its newest game. */
  endMs: number;
  /** `recap:<entryKey ?? eventId>`: the id in the device-local dismissal store, independent of any horizon. */
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
  /**
   * 39.2-REVIEW WEB-WR-01: the events the last visit saw (the digest's frozen seen set), so
   * "synced since last seen" is tested on sync order, not play time. `null`/absent for a first
   * visit or a snapshot written before the set existed (the play-time rule then applies).
   */
  seenEvents?: DigestSeenEvents | null;
  /** The digest's snapshot has been read; until then nothing is decided. */
  ready: boolean;
  /** False when the page is not showing the card (no fighters chosen): nothing is selected. */
  enabled?: boolean;
}

const NO_CANDIDATE: RecapCandidateResult = { status: 'none', candidate: null, dismiss: () => {} };

/**
 * The dismissal id for a recap: the entry key when the registry has one, else the event's
 * identity (`eventId`, one proximity block) — never a bare event name, which every same-named
 * weekly would share (39.2-REVIEW WEB-CR-01).
 */
export function recapDismissalId(entryKey: string | null, eventId: string): string {
  return `recap:${entryKey ?? eventId}`;
}

/** The newest event the recap considers, as `selectNewestEvent` returns it. */
export interface NewestEvent {
  eventKey: string;
  eventId: string;
  games: Match[];
  newestGame: Match;
  /** The shared event-identity block the event is. */
  block: EventBlock;
}

/**
 * The event holding the subject's newest event-named game, with that event's games only; `null`
 * when no game names an event. An event is one proximity block of one event name at one
 * tournament (shared `newestEventBlock`), so ten "Ultimate Singles" weeklies are ten events.
 */
export function selectNewestEvent(matches: readonly Match[]): NewestEvent | null {
  const newest = newestEventBlock(matches);
  if (newest === null) return null;
  return {
    eventKey: newest.block.eventKey,
    eventId: newest.block.key,
    games: newest.block.games,
    newestGame: newest.newestGame,
    block: newest.block,
  };
}

/**
 * 39.2-REVIEW WEB-WR-01: the event has games synced since the last visit — it is absent from that
 * visit's seen set, or holds more games than it did then (the shared `hasEventSyncedSince`).
 * Without a stored seen set, its newest game is later than `lastSeenAt` (the pre-fix rule). A
 * first visit on this device (`lastSeenAt === null`) lets any event qualify.
 */
function syncedSinceLastSeen(
  event: NewestEvent,
  lastSeenAt: number | null,
  seenEvents: DigestSeenEvents | null | undefined,
): boolean {
  if (lastSeenAt === null) return true;
  const block: EventBlock = { ...event.block, endMs: event.newestGame.time };
  return hasEventSyncedSince(block, { lastSeenAt, events: seenEvents ?? undefined });
}

/**
 * D-12 as amended by D-18: the newest event shows its recap when it is complete, its end is
 * within the last fourteen days (a DATE test on the shared `FOURTEEN_DAYS_MS`, never the
 * server's debrief window), it has games SYNCED since the last visit (39.2-REVIEW WEB-WR-01:
 * sync order through the frozen seen set, not play time), and it has not been dismissed on this
 * device. Pure.
 */
export function evaluateRecapCandidate(input: {
  event: NewestEvent;
  lastSeenAt: number | null;
  seenEvents?: DigestSeenEvents | null;
  nowMs: number;
  dismissedIds: readonly string[];
  entry: RecapEntry | null;
}): RecapCandidate | null {
  const { event, lastSeenAt, seenEvents, nowMs, dismissedIds, entry } = input;
  const newestGameAt = event.newestGame.time;
  if (!syncedSinceLastSeen(event, lastSeenAt, seenEvents)) return null;
  const endMs = (entry ? entryDisplayDateRange(entry.entry)?.endMs : undefined) ?? newestGameAt;
  if (endMs > nowMs) return null;
  if (nowMs - endMs > FOURTEEN_DAYS_MS) return null;
  const dismissalId = recapDismissalId(entry?.entryKey ?? null, event.eventId);
  if (dismissedIds.includes(dismissalId)) return null;
  return {
    eventKey: event.eventKey,
    eventId: event.eventId,
    games: entry?.games ?? event.games,
    newestGameAt,
    endMs,
    dismissalId,
    entry,
  };
}

/** The shared reads both subject paths need: the subject's games, its dismissals and one clock. */
function useRecapInputs({
  lastSeenAt,
  seenEvents = null,
  ready,
  enabled = true,
}: UseRecapCandidateInput) {
  const { allMatches } = useFilteredMatches();
  const dismissals = useInsightDismissals();
  // The clock is read once (the React Compiler forbids a bare `Date.now()` in the render body).
  const [nowMs] = useState(() => Date.now());
  const event = useMemo(
    () => (ready && enabled ? selectNewestEvent(allMatches) : null),
    [allMatches, ready, enabled],
  );
  return { allMatches, dismissals, nowMs, event, lastSeenAt, seenEvents };
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
  const { dismissals, nowMs, event, lastSeenAt, seenEvents } = useRecapInputs(input);
  const candidate = useMemo(
    () =>
      event
        ? evaluateRecapCandidate({
            event,
            lastSeenAt,
            seenEvents,
            nowMs,
            dismissedIds: dismissals.dismissedIds,
            entry: null,
          })
        : null,
    [event, lastSeenAt, seenEvents, nowMs, dismissals.dismissedIds],
  );
  return finish(candidate, dismissals.dismiss);
}

/**
 * The own-account recap source: the same selection, enriched with the registry row whose
 * attributed games include the event's newest game — and the card then reads that entry's own
 * attributed games, never a name-grouped set (the one shared `resolveEntryTiers` the
 * Tournaments page resolves with, so the card and the table can never disagree on a tier).
 * While the registry is still pending and an event could qualify the status is `loading`, so
 * the Dashboard can hold the recap's cell instead of resizing the digest when it lands. A
 * failed registry read degrades to the matches-only candidate.
 */
export function useOwnAccountRecapCandidate(input: UseRecapCandidateInput): RecapCandidateResult {
  const { allMatches, dismissals, nowMs, event, lastSeenAt, seenEvents } = useRecapInputs(input);
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
      games: item.matches,
    };
  }, [event, entries, allMatches]);

  const candidate = useMemo(
    () =>
      event && !entriesPending
        ? evaluateRecapCandidate({
            event,
            lastSeenAt,
            seenEvents,
            nowMs,
            dismissedIds: dismissals.dismissedIds,
            entry,
          })
        : null,
    [event, entriesPending, lastSeenAt, seenEvents, nowMs, dismissals.dismissedIds, entry],
  );

  if (event && entriesPending) {
    // Could this event qualify once the registry lands? The registry's end is never earlier than
    // the newest game, so games synced since last seen and a newest game inside the window is
    // the cheap test.
    const newestGameAt = event.newestGame.time;
    const possible =
      syncedSinceLastSeen(event, lastSeenAt, seenEvents) &&
      newestGameAt <= nowMs &&
      nowMs - newestGameAt <= FOURTEEN_DAYS_MS;
    return possible ? { status: 'loading', candidate: null, dismiss: () => {} } : NO_CANDIDATE;
  }
  return finish(candidate, dismissals.dismiss);
}
