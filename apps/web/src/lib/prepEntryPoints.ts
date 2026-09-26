import type { PrepBriefStatus, TournamentEntry } from '@smash-tracker/shared';
import { entryDisplayDateRange, isAdminImportedEntry } from '@/lib/historicalTournament';
import { derivePrepSurfaceMode } from '@/lib/prepSurfaceMode';

/**
 * Plan 39-12 (PREP-05, D-13): the ONE home of the date and upcoming-entry
 * logic the three prep/debrief entry points share — the dashboard prep slot,
 * the opponent hub's prep-brief card and (for the review predicate) the
 * tournament detail CTA. Pure; no hooks, no fetches.
 */

/** A registry entry known to carry a routable `entryKey`. */
export type RoutableTournamentEntry = TournamentEntry & { entryKey: string };

/** D-13: how long after the server's conversion moment a debrief door stays on offer. */
export const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Matches `TournamentHeader.tsx`'s exact locale-aware date-formatting call shape. */
export function formatEntryDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Ascending `entryKey` order — the tiebreak every multi-entry pick below uses, so a destination is deterministic. */
function compareEntryKeys(a: RoutableTournamentEntry, b: RoutableTournamentEntry): number {
  return a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0;
}

/**
 * Every upcoming entry, nearest first: `firstSetAt` strictly greater than
 * `now`, ascending, ties broken by `entryKey` ascending. Restricted to
 * entries with a routable `entryKey` (the registry always fills it on read,
 * so this only guards defensively against a malformed/legacy record).
 *
 * Phase 30.3 (Gate 6, prep-bypass closure): also excludes every
 * admin-imported historical row (`isAdminImportedEntry`), mirroring
 * `TournamentDetailPage.tsx`'s existing prep-CTA guard — an imported
 * snapshot is a PAST public-data record, so it must never surface as an
 * "upcoming event" and link into `/tournaments/:entryKey/prep`, even if its
 * imported `firstSetAt` is (mistakenly, or adversarially) recorded in the
 * future. Checked BEFORE the date comparison so a future-dated imported
 * fixture is excluded on the origin alone, never on timing.
 */
export function listUpcomingEntries(
  entries: readonly TournamentEntry[],
  now: number,
): RoutableTournamentEntry[] {
  const upcoming: RoutableTournamentEntry[] = [];
  for (const entry of entries) {
    if (!entry.entryKey || isAdminImportedEntry(entry) || entry.firstSetAt <= now) {
      continue;
    }
    upcoming.push(entry as RoutableTournamentEntry);
  }
  return upcoming.sort((a, b) => a.firstSetAt - b.firstSetAt || compareEntryKeys(a, b));
}

/**
 * "Nearest" upcoming entry (Phase 26 D-01): the head of
 * `listUpcomingEntries` — the smallest `firstSetAt` strictly greater than
 * `now`, ties broken by `entryKey` ascending. Moved here from
 * `DashboardPrepActionSlot.tsx` (plan 39-12, review C1-M5) so the dashboard
 * and the opponent hub share ONE definition of "upcoming".
 */
export function findNearestUpcomingEntry(
  entries: readonly TournamentEntry[],
  now: number,
): RoutableTournamentEntry | null {
  return listUpcomingEntries(entries, now)[0] ?? null;
}

/** A debrief candidate plus the display end date it was ordered by (so a caller never re-reads the date). */
export interface PastEntryCandidate {
  entry: RoutableTournamentEntry;
  endMs: number;
}

/**
 * The debrief CANDIDATE: the most recent past entry, by
 * `entryDisplayDateRange(entry).endMs`, ties broken by `entryKey` ascending.
 *
 * ORIGIN BEFORE TIMING (review C1-H7, Phase 30.3 Gate 6): an admin-imported
 * row is skipped before any date is read, exactly as
 * `listUpcomingEntries` orders it — an imported historical record is a past
 * public-data record by definition and would otherwise qualify for every
 * backward-looking window.
 *
 * An entry with no usable display date (`entryDisplayDateRange` returns
 * `null`, e.g. a manual entry recorded without one) is never a candidate, so
 * no link or date string is ever computed from a missing date.
 *
 * This only ORDERS candidates. Whether the candidate is actually in review is
 * the SERVER's answer (`isDebriefWindowOpen` below) — never this date.
 */
export function findMostRecentPastEntry(
  entries: readonly TournamentEntry[],
  now: number,
): PastEntryCandidate | null {
  let best: PastEntryCandidate | null = null;
  for (const entry of entries) {
    if (!entry.entryKey || isAdminImportedEntry(entry)) {
      continue;
    }
    const range = entryDisplayDateRange(entry);
    if (range === null || range.endMs > now) {
      continue;
    }
    const routable = entry as RoutableTournamentEntry;
    if (
      best === null ||
      range.endMs > best.endMs ||
      (range.endMs === best.endMs && compareEntryKeys(routable, best.entry) < 0)
    ) {
      best = { entry: routable, endMs: range.endMs };
    }
  }
  return best;
}

/**
 * Review C1-H6: the debrief window is the SERVER's answer, never a client
 * date derivation — 28-CONTEXT.md's "⚠ ONE CORRECTION" rejected deriving
 * review mode from raw entry dates, because a manually-entered event whose
 * `firstSetAt` resolves to the start of today would satisfy a naive
 * fourteen-day window immediately and the destination would render prep
 * while the door promised a debrief. The window therefore COMPOSES the
 * destination page's own `derivePrepSurfaceMode` (activated, `reviewAt`
 * present and passed) and only adds the fourteen-day cap on top, so a door
 * this returns `true` for always lands in review mode.
 */
export function isDebriefWindowOpen(status: PrepBriefStatus, now: number): boolean {
  return (
    derivePrepSurfaceMode(status, now) === 'review' &&
    status.reviewAt !== undefined &&
    now - status.reviewAt <= FOURTEEN_DAYS_MS
  );
}
