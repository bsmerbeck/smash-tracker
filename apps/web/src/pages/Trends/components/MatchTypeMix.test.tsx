import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { MatchTypeMix, bucketMatchType } from './MatchTypeMix';
import { useTrendsCardInsights } from '../lib/useTrendsCardInsights';

const NOW = Date.now();

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

/**
 * Plan 39.1-27 (gap closure, SC4/INS-04): the harness obtains
 * `mixShiftInsight`/`volumeFormInsight` from the SAME `useTrendsCardInsights`
 * hook the host page (`TrendsPage.tsx`) calls once — never a hand-built
 * `Insight` literal — mirroring `SettingComparison.test.tsx`'s own harness
 * precedent from this same plan's Task 1.
 */
function MatchTypeMixHarness({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { mixShift, volumeForm } = useTrendsCardInsights({ matches, horizon });
  return (
    <MatchTypeMix
      matches={matches}
      horizon={horizon}
      mixShiftInsight={mixShift}
      volumeFormInsight={volumeForm}
    />
  );
}

function renderMix(matches: Match[], horizon: HorizonKey = 'last30') {
  return render(
    <MemoryRouter>
      <MatchTypeMixHarness matches={matches} horizon={horizon} />
    </MemoryRouter>,
  );
}

describe('bucketMatchType', () => {
  it('buckets tourney/friendly/quickplay/unspecified correctly', () => {
    expect(bucketMatchType('online-tourney')).toBe('tourney');
    expect(bucketMatchType('offline-tourney')).toBe('tourney');
    expect(bucketMatchType('online-friendly')).toBe('friendly');
    expect(bucketMatchType('offline-friendly')).toBe('friendly');
    expect(bucketMatchType('quickplay')).toBe('quickplay');
    expect(bucketMatchType('none')).toBe('unspecified');
    expect(bucketMatchType(undefined)).toBe('unspecified');
  });
});

describe('MatchTypeMix', () => {
  it('imports no legacy canvas chart library', () => {
    // Regression proof for DD-10: this source file must not import chart.js
    // or react-chartjs-2 (chartKitBoundary.test.ts's own oracle covers the
    // repo-wide guarantee; this is the direct, file-local statement).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const source = fs.readFileSync(path.resolve(__dirname, 'MatchTypeMix.tsx'), 'utf8');
    expect(source).not.toMatch(/from\s+['"](chart\.js|react-chartjs-2)['"]/);
  });

  it('renders two share bars with localised labels and no raw enum value', () => {
    const matches = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `q${i}`, time: NOW - (5 - i) * 60_000, win: true, matchType: 'quickplay' }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({
          id: `t${i}`,
          time: NOW - (5 - i) * 60_000,
          win: false,
          matchType: 'offline-tourney',
        }),
      ),
    ];
    renderMix(matches);

    expect(screen.getAllByText('Quickplay').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tourney').length).toBeGreaterThan(0);
    expect(screen.queryByText('quickplay')).not.toBeInTheDocument();
    expect(screen.queryByText('offline-tourney')).not.toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
    expect(screen.getByText('Last 30 games')).toBeInTheDocument();
  });

  it('WR-A02: the mix-shift fact line resolves the raw matchType key to its localized label, never leaking the raw enum literal', () => {
    // 70 old offline-tourney games (baseline) + 30 recent online-tourney
    // games (the last30 window): a 70-point recent-vs-lifetime share shift,
    // well past MIX_SHIFT_MIN_POINTS (15) and TREND_MIN_RECENT_GAMES (8).
    const matches: Match[] = [
      ...Array.from({ length: 70 }, (_, i) =>
        makeMatch({
          id: `old-${i}`,
          time: NOW - (1000 - i) * 60_000,
          win: true,
          matchType: 'offline-tourney',
        }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        makeMatch({
          id: `recent-${i}`,
          time: NOW - (30 - i) * 60_000,
          win: true,
          matchType: 'online-tourney',
        }),
      ),
    ];
    renderMix(matches);

    // The localized label ("Online Tourney"), never the raw enum literal.
    expect(screen.getAllByText(/Online Tourney/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/online-tourney/)).not.toBeInTheDocument();
  });

  it('renders the volume-form line even on a small account (locked state)', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ id: `g${i}`, time: NOW - (5 - i) * 60_000, win: true, matchType: 'quickplay' }),
    );
    renderMix(matches);

    expect(screen.getByText(/unlock the volume read/)).toBeInTheDocument();
  });

  it('renders no card content when there are no matches', () => {
    renderMix([]);
    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  describe('T-39.1-27 (gap closure, SC4/INS-04): MixShift and VolumeForm doors via buildInsightDoors', () => {
    it('renders a VolumeForm games door whose href carries claim=volumeForm and #games, with a count equal to countedMatchIds.length', () => {
      const matches = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `g${i}`, time: NOW - (5 - i) * 60_000, win: true, matchType: 'quickplay' }),
      );
      const { container } = renderMix(matches);

      // The VolumeForm line is the last `[data-slot="insight-line"]` in this
      // fixture (MixShift is hidden — a 5-game/1-month fixture never clears
      // TREND_MIN_RECENT_GAMES for a share-shift read).
      const lines = container.querySelectorAll('[data-slot="insight-line"]');
      expect(lines.length).toBeGreaterThan(0);
      const volumeFormLine = lines[lines.length - 1]!;
      const doorSlot = volumeFormLine.querySelector('[data-slot="insight-line-door"]');
      expect(doorSlot).not.toBeNull();
      const door = doorSlot!.querySelector('a') as HTMLAnchorElement;
      expect(door).not.toBeNull();

      const href = door.getAttribute('href') ?? '';
      expect(href).toContain('claim=volumeForm');
      expect(href).toContain('#games');

      const labelCount = Number((door.textContent ?? '').match(/\d+/)?.[0] ?? '0');
      expect(labelCount).toBe(5);
    });

    it('renders a MixShift games door with the localized match-type label (never a raw enum) and claim=mixShift', () => {
      // Same WR-A02 fixture as above: a real, visible MixShift 'fact' state.
      const matches: Match[] = [
        ...Array.from({ length: 70 }, (_, i) =>
          makeMatch({
            id: `old-${i}`,
            time: NOW - (1000 - i) * 60_000,
            win: true,
            matchType: 'offline-tourney',
          }),
        ),
        ...Array.from({ length: 30 }, (_, i) =>
          makeMatch({
            id: `recent-${i}`,
            time: NOW - (30 - i) * 60_000,
            win: true,
            matchType: 'online-tourney',
          }),
        ),
      ];
      const { container } = renderMix(matches);

      const mixShiftText = screen.getAllByText(/Online Tourney/)[0]!;
      const mixShiftLine = mixShiftText.closest('[data-slot="insight-line"]') as HTMLElement;
      expect(mixShiftLine).not.toBeNull();
      const doorSlot = mixShiftLine.querySelector('[data-slot="insight-line-door"]');
      expect(doorSlot).not.toBeNull();
      const door = doorSlot!.querySelector('a') as HTMLAnchorElement;
      expect(door).not.toBeNull();

      const href = door.getAttribute('href') ?? '';
      expect(href).toContain('claim=mixShift');
      expect(href).toContain('#games');

      const labelCount = Number((door.textContent ?? '').match(/\d+/)?.[0] ?? '0');
      expect(labelCount).toBe(30);

      // The raw enum literal never reaches this rendered container (WR-A02).
      expect(container.textContent).not.toMatch(/online-tourney/);
    });
  });
});
