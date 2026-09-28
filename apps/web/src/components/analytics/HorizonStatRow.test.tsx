import { describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { buildPeriodSeries } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';

/**
 * Plan 39.1-43 Task 1 (hero-idioms-kit, sketch 003 A "Hero port"): the Fighter
 * hero's all-time lead figure and its three horizon figures move VERBATIM into
 * the kit, so plan 44's pairing hero renders the same piece. The module is
 * imported inside each test body so this file loads (and fails per case)
 * before the component exists.
 */

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
const DAY_MS = 24 * 60 * 60 * 1000;
/** One fixed clock for every render, so the kit and the hero resolve identical windows. */
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

/** 200 games one day apart with a named event every 20 — populated horizons. */
function largeFixture(): Match[] {
  return Array.from({ length: 200 }, (_, i) =>
    makeMatch({
      id: `g${i}`,
      time: NOW_MS - (200 - i) * DAY_MS,
      win: i % 3 !== 0,
      eventName: i % 20 === 0 ? `Event ${Math.floor(i / 20)}` : undefined,
      matchType: i % 2 === 0 ? 'quickplay' : 'online-tourney',
    }),
  );
}

/** 40 recent games with no event — both game / day horizons collapse, last event is empty. */
function fortyGameFixture(): Match[] {
  return Array.from({ length: 40 }, (_, i) =>
    makeMatch({ id: `c${i}`, time: NOW_MS - (40 - i) * 60 * 60 * 1000, win: i % 2 === 0 }),
  );
}

/** 40 games all older than 12 months — every scoped window is empty. */
function staleFixture(): Match[] {
  return Array.from({ length: 40 }, (_, i) =>
    makeMatch({ id: `s${i}`, time: NOW_MS - (400 + (40 - i)) * DAY_MS, win: i % 2 === 0 }),
  );
}

const MODULE_SPECIFIER = './HorizonStatRow';

interface HorizonStatRowProps {
  matches: Match[];
  horizon: HorizonKey;
  onSelectHorizon: (next: HorizonKey) => void;
  disabled: boolean;
  nowMs: number;
}

async function loadHorizonStatRow(): Promise<ComponentType<HorizonStatRowProps>> {
  const mod = (await import(/* @vite-ignore */ MODULE_SPECIFIER).catch(() => null)) as {
    HorizonStatRow?: ComponentType<HorizonStatRowProps>;
  } | null;
  expect(mod?.HorizonStatRow, 'HorizonStatRow is exported').toBeTypeOf('function');
  return mod!.HorizonStatRow!;
}

async function renderRow(props: {
  matches: Match[];
  horizon?: HorizonKey;
  disabled?: boolean;
  onSelectHorizon?: (next: HorizonKey) => void;
}) {
  const HorizonStatRow = await loadHorizonStatRow();
  const onSelectHorizon = props.onSelectHorizon ?? vi.fn();
  const result = render(
    <HorizonStatRow
      matches={props.matches}
      horizon={props.horizon ?? 'last30'}
      onSelectHorizon={onSelectHorizon}
      disabled={props.disabled ?? false}
      nowMs={NOW_MS}
    />,
  );
  return { onSelectHorizon, ...result };
}

function figureButton(label: string): HTMLElement {
  return screen.getByText(label).closest('button') as HTMLElement;
}

describe('HorizonStatRow (plan 39.1-43, hero-idioms-kit)', () => {
  it('renders the lead "All time" figure first, then 30 games / Last event / 90 days, in one stat-row', async () => {
    const { container } = await renderRow({ matches: largeFixture() });
    const row = container.querySelector('[data-slot="stat-row"]') as HTMLElement;
    expect(row).not.toBeNull();
    const labels = [...row.children].map(
      (figure) => figure.querySelector('span')?.textContent ?? '',
    );
    expect(labels).toEqual(['All time', '30 games', 'Last event', '90 days']);
    // The lead figure is not a horizon button; it carries the all-time rate and record.
    expect(row.children[0]!.tagName).toBe('DIV');
    expect(row.children[0]!.textContent).toMatch(/^All time\d+%/);
  });

  it('each horizon figure is a button whose aria-pressed tracks the page horizon', async () => {
    await renderRow({ matches: largeFixture(), horizon: 'lastEvent' });
    expect(figureButton('30 games')).toHaveAttribute('aria-pressed', 'false');
    expect(figureButton('Last event')).toHaveAttribute('aria-pressed', 'true');
    expect(figureButton('90 days')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a click calls onSelectHorizon with that figure key', async () => {
    const { onSelectHorizon } = await renderRow({ matches: largeFixture(), horizon: 'last30' });
    figureButton('90 days').click();
    expect(onSelectHorizon).toHaveBeenCalledWith('last90');
  });

  it('is inert while disabled — a click writes no horizon', async () => {
    const { onSelectHorizon } = await renderRow({
      matches: largeFixture(),
      horizon: 'last30',
      disabled: true,
    });
    figureButton('Last event').click();
    expect(onSelectHorizon).not.toHaveBeenCalled();
  });

  it('collapsed state: the forty-game account reads "= all games" and only the event-less last-event figure carries the "no games" chip', async () => {
    const { container } = await renderRow({ matches: fortyGameFixture() });
    expect(screen.getAllByText('= all games').length).toBeGreaterThanOrEqual(1);
    const chips = [...container.querySelectorAll('[data-slot="delta-chip"]')];
    expect(chips.map((chip) => chip.getAttribute('data-state'))).toEqual(['none']);
    expect(chips[0]!.textContent).toBe('no games');
    expect(figureButton('Last event')).toContainElement(chips[0] as HTMLElement);
  });

  it('none state: a stale account renders three muted em dashes with the "no games" chip, never "Steady"', async () => {
    const { container } = await renderRow({ matches: staleFixture() });
    for (const label of ['30 games', 'Last event', '90 days']) {
      const button = figureButton(label);
      expect(button.textContent).toContain('—');
      expect(button.querySelector('[data-slot="delta-chip"]')?.textContent).toBe('no games');
    }
    expect(container.textContent).not.toMatch(/steady/i);
  });

  it('populated state: the large fixture renders a rate and a record on every horizon figure', async () => {
    await renderRow({ matches: largeFixture() });
    for (const label of ['30 games', 'Last event', '90 days']) {
      expect(figureButton(label).textContent).toMatch(/\d+%\d+–\d+/);
    }
  });

  it('parity: renders exactly what the Fighter hero renders for the same fixture, horizon and clock', async () => {
    const { FighterHero } = await import('@/pages/FighterAnalysis/components/FighterHero');
    const HorizonStatRow = await loadHorizonStatRow();
    for (const fixture of [largeFixture(), fortyGameFixture(), staleFixture()]) {
      for (const horizon of ['last30', 'lastEvent', 'last90'] as const) {
        const hero = render(
          <MemoryRouter>
            <FighterHero
              fighter={mario}
              fighterMatches={fixture}
              allMatches={fixture}
              horizon={horizon}
              setHorizon={vi.fn()}
              isLoading={false}
              formNowInsight={null}
              nowMs={NOW_MS}
              periodSeries={buildPeriodSeries({ matches: fixture })}
              onDrill={vi.fn()}
            />
          </MemoryRouter>,
        );
        const heroRow = hero.container.querySelector('[data-slot="stat-row"]')!.outerHTML;
        hero.unmount();
        const kit = render(
          <HorizonStatRow
            matches={fixture}
            horizon={horizon}
            onSelectHorizon={vi.fn()}
            disabled={false}
            nowMs={NOW_MS}
          />,
        );
        expect(kit.container.querySelector('[data-slot="stat-row"]')!.outerHTML).toBe(heroRow);
        kit.unmount();
      }
    }
  });
});
