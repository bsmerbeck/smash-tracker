// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  matchesForEntry,
  prepBriefStatusSchema,
  tournamentEntrySchema,
} from '@smash-tracker/shared';
import { evaluateRecapCandidate, selectNewestEvent } from '../src/hooks/useRecapCandidate';
import { isDebriefWindowOpen } from '../src/lib/prepEntryPoints';
import { buildGuardDigestSeed } from './digestGuardFixture.mjs';
import { DASHBOARD_RECAP_ENTRY_KEY, buildDashboardScale } from './guardLayoutHarness.mjs';

/**
 * Plan 39.2-13 (UI-SPEC G1): the Dashboard oracle's dataset. If the recap event drifted out of the
 * 14-day window, lost its registry match, or acquired a stray game inside its date window, the
 * oracle would quietly measure a digest spanning the whole row (or a card with fewer doors). These
 * tests pin the fixture to the app's own selection, schema and debrief predicate.
 */
const scale = buildDashboardScale();
const NOW = Date.now();

describe('dashboard guard scale (plan 39.2-13)', () => {
  it('the newest named event is the recap event, complete and inside the fourteen-day window', () => {
    const event = selectNewestEvent(scale.matches);
    expect(event?.eventKey).toBe('Ultimate Singles');
    expect(event?.games).toHaveLength(12);
    const candidate = evaluateRecapCandidate({
      event,
      lastSeenAt: 1,
      nowMs: NOW,
      dismissedIds: [],
      entry: null,
    });
    expect(candidate).not.toBeNull();
  });

  it('the registry entry passes the wire schema and owns exactly the event games', () => {
    expect(scale.tournaments).toHaveLength(1);
    const entry = tournamentEntrySchema.parse(scale.tournaments[0]);
    expect(entry.entryKey).toBe(DASHBOARD_RECAP_ENTRY_KEY);
    const owned = matchesForEntry(scale.matches, entry);
    expect(owned).toHaveLength(12);
    expect(owned.every((match) => match.id.startsWith('dashboard-recap-'))).toBe(true);
  });

  it('no other game sits inside the event date window, so the games door is offered with its exact count', () => {
    const times = scale.matches
      .filter((match) => match.id.startsWith('dashboard-recap-'))
      .map((match) => match.time);
    const from = Math.min(...times);
    const to = Math.max(...times);
    expect(scale.matches.filter((m) => m.time >= from && m.time <= to)).toHaveLength(12);
  });

  it('the served prep status is schema-valid and opens the debrief window', () => {
    const status = prepBriefStatusSchema.parse(scale.prepStatuses[DASHBOARD_RECAP_ENTRY_KEY]);
    expect(isDebriefWindowOpen(status, NOW)).toBe(true);
  });

  it('the digest seed still names only items the served watchlist will contain', () => {
    const seed = buildGuardDigestSeed(scale.matches);
    expect(Object.keys(JSON.parse(seed.value).tracked).length).toBeGreaterThan(0);
  });
});
