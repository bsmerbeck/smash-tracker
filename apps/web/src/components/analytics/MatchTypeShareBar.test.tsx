import { describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { buildPeriodSeries } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 39.1-43 Task 1 (hero-idioms-kit, sketch 001-C / 003 `shareBar`): the
 * Fighter hero's by-match-type ShareBar with its per-type horizon chips (plan
 * 36 semantics — each type's recent window against THAT type's own all-time
 * record) moves VERBATIM into the kit for plan 44's pairing hero. The module
 * is imported inside each test body so the file loads before it exists.
 */

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 20, 12);

function makeMatch(overrides: Partial<Match> & { id: string; time: number; win: boolean }): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: '',
    notes: '',
    matchType: 'quickplay',
    ...overrides,
  } as Match;
}

const TYPES = ['quickplay', 'online-tourney', 'offline-tourney'] as const;

/** 40 games older than 12 months over three types (14 / 13 / 13), plus `recent` quickplay games this week. */
function fixture(recent = 0): Match[] {
  return [
    ...Array.from({ length: 40 }, (_, i) =>
      makeMatch({
        id: `stale${i}`,
        time: NOW_MS - (400 + (40 - i)) * DAY_MS,
        win: i % 2 === 0,
        matchType: TYPES[i % 3],
      }),
    ),
    ...Array.from({ length: recent }, (_, i) =>
      makeMatch({
        id: `fresh${i}`,
        time: NOW_MS - (3 - i * 0.1) * DAY_MS,
        win: i % 2 === 0,
        matchType: 'quickplay',
      }),
    ),
  ];
}

const MODULE_SPECIFIER = './MatchTypeShareBar';

interface MatchTypeShareBarProps {
  matches: Match[];
  horizon: HorizonKey;
  nowMs: number;
}

async function loadMatchTypeShareBar(): Promise<ComponentType<MatchTypeShareBarProps>> {
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(() => null)) as {
    MatchTypeShareBar?: ComponentType<MatchTypeShareBarProps>;
  } | null;
  expect(mod?.MatchTypeShareBar, 'MatchTypeShareBar is exported').toBeTypeOf('function');
  return mod!.MatchTypeShareBar!;
}

async function renderBar(matches: Match[], horizon: HorizonKey = 'last30') {
  const MatchTypeShareBar = await loadMatchTypeShareBar();
  return render(<MatchTypeShareBar matches={matches} horizon={horizon} nowMs={NOW_MS} />);
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="share-bar-row"]')];
}

describe('MatchTypeShareBar (plan 39.1-43, hero-idioms-kit)', () => {
  it('renders one segment and one row per match type, most games first', async () => {
    const { container } = await renderBar(fixture(4));
    expect(container.querySelectorAll('[data-slot="share-bar-segment"]')).toHaveLength(3);
    expect(rows(container).map((row) => row.textContent?.split(/\d/)[0])).toEqual([
      'Quickplay',
      'Online tournament',
      'Offline tournament',
    ]);
  });

  it('header is the "By match type" overline', async () => {
    const { container } = await renderBar(fixture());
    const header = container.querySelector('[data-slot="match-type-share-overline"]');
    expect(header?.textContent).toBe('By match type');
    expect(header?.className).toMatch(/uppercase/);
    expect(header?.className).toMatch(/tracking-wider/);
  });

  it('a type with no recent games reads the none chip carrying the horizon ("no games · last 30")', async () => {
    const { container } = await renderBar(fixture());
    for (const row of rows(container)) {
      const chip = row.querySelector('[data-slot="delta-chip"]');
      expect(chip?.getAttribute('data-state')).toBe('none');
      expect(chip?.textContent).toBe('no games· last 30');
    }
  });

  it("each row's chip compares THAT type's recent window with THAT type's all time (2 recent quickplay games -> thin)", async () => {
    const { container } = await renderBar(fixture(2));
    const quickplay = rows(container).find((row) => row.textContent?.includes('Quickplay'))!;
    const chip = quickplay.querySelector('[data-slot="delta-chip"]')!;
    expect(chip.getAttribute('data-state')).toBe('thin');
    expect(chip.textContent).toBe('n 2 · no direction');
    const online = rows(container).find((row) => row.textContent?.includes('Online'))!;
    expect(online.querySelector('[data-slot="delta-chip"]')?.getAttribute('data-state')).toBe(
      'none',
    );
  });

  it('the chips follow the page horizon ("· last 90 days")', async () => {
    const { container } = await renderBar(fixture(), 'last90');
    for (const row of rows(container)) {
      expect(row.querySelector('[data-slot="delta-chip"]')?.textContent).toBe(
        'no games· last 90 days',
      );
    }
  });

  it('0 games renders the empty line, no bar', async () => {
    const { container } = await renderBar([]);
    expect(container.querySelector('[data-slot="share-bar-empty"]')?.textContent).toBe(
      'No games to show yet.',
    );
    expect(container.querySelector('[data-slot="share-bar"]')).toBeNull();
  });

  it('parity: its rows equal the Fighter hero share-bar rows for the same fixture, horizon and clock', async () => {
    const { FighterHero } = await import('@/pages/FighterAnalysis/components/FighterHero');
    const MatchTypeShareBar = await loadMatchTypeShareBar();
    for (const matches of [fixture(), fixture(2), fixture(6)]) {
      const hero = render(
        <MemoryRouter>
          <FighterHero
            fighter={mario}
            fighterMatches={matches}
            allMatches={matches}
            horizon="last30"
            setHorizon={vi.fn()}
            isLoading={false}
            formNowInsight={null}
            nowMs={NOW_MS}
            periodSeries={buildPeriodSeries({ matches })}
            onDrill={vi.fn()}
          />
        </MemoryRouter>,
      );
      const heroRows = hero.container.querySelector('[data-slot="share-bar-root"] ul')!.outerHTML;
      hero.unmount();
      const kit = render(<MatchTypeShareBar matches={matches} horizon="last30" nowMs={NOW_MS} />);
      expect(kit.container.querySelector('[data-slot="share-bar-root"] ul')!.outerHTML).toBe(
        heroRows,
      );
      kit.unmount();
    }
  });
});
