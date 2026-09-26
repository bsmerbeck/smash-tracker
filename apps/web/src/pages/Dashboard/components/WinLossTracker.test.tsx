import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Fighter, HorizonKey, Match } from '@smash-tracker/shared';
import { SpriteList } from '@/data/sprites';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { WinLossTracker } from './WinLossTracker';

const mario = SpriteList.find((s) => s.id === 1)!;
const falco = SpriteList.find((s) => s.name === 'Falco')!;

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

// No default parameter: `renderTracker(matches, undefined)` must actually
// pass `undefined` through (a JS default parameter treats an explicit
// `undefined` argument as "use the default", silently defeating the
// no-fighter-selected test case below).
function renderTracker(
  matches: Match[],
  fighter: Fighter | undefined,
  horizon: HorizonKey = 'last30',
) {
  const contextValue: DashboardContextValue = {
    fighterSprites: [mario, falco],
    fighter,
    setFighter: vi.fn(),
  };
  const tree = (h: HorizonKey) => (
    <DashboardContext.Provider value={contextValue}>
      <WinLossTracker matches={matches} horizon={h} />
    </DashboardContext.Provider>
  );
  const result = render(tree(horizon));
  return { ...result, rerenderHorizon: (h: HorizonKey) => result.rerender(tree(h)) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tile's lead figure (`figure-lg`: the StatFigure `lead` size). */
function leadValue(): string | undefined {
  return (
    Array.from(document.querySelectorAll('[class*="text-[1.75rem]"]'))[0]?.textContent ?? undefined
  );
}

/**
 * Falco: the newest 30 games are losses (one a day), 10 older wins sit inside
 * 90 days, and 60 wins from ~200 days ago keep both windows under the
 * engine's collapse ratio of the 70–30 all-time baseline, so a chip shows at
 * last30 and at last90. One Mario game proves only the selected fighter counts.
 */
function horizonFixture(): Match[] {
  const now = Date.now();
  const recentLosses = Array.from({ length: 30 }, (_, i) =>
    makeMatch({ id: `l${i}`, time: now - (i + 1) * DAY_MS, win: false, fighter_id: falco.id }),
  );
  const olderWins = Array.from({ length: 10 }, (_, i) =>
    makeMatch({ id: `w${i}`, time: now - (40 + i) * DAY_MS, win: true, fighter_id: falco.id }),
  );
  const oldWins = Array.from({ length: 60 }, (_, i) =>
    makeMatch({ id: `o${i}`, time: now - (200 + i) * DAY_MS, win: true, fighter_id: falco.id }),
  );
  const marioGame = makeMatch({ id: 'mario', time: now - DAY_MS, win: true });
  return [...recentLosses, ...olderWins, ...oldWins, marioGame];
}

/**
 * Plan 39.1-17 (UIX-04): the last page-local stat component on this surface
 * is gone, replaced by the ONE stat idiom (`StatRow`/`StatFigure`) — no more
 * `flex justify-evenly` collision (owner's "garbage spacing" note).
 */
describe('WinLossTracker', () => {
  // Plan 39.1-50 (OOS-12a) REWROTE this case from the three-figure StatRow
  // anatomy to the hero-tile anatomy. Reason: UI-SPEC section 8.7 (the
  // OverallRecordCard anatomy — overline, figure-lg lead, Record support,
  // horizon DeltaChip) and section 6.5 rule 4 (no figure stated twice: wins,
  // rate and losses are the one Record line). The no-justify-evenly assertion
  // is kept verbatim.
  it('renders the fighter record as a hero tile: overline, win-rate lead, Record support', () => {
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: falco.id }),
      makeMatch({ id: '2', time: 2, win: true, fighter_id: falco.id }),
      makeMatch({ id: '3', time: 3, win: false, fighter_id: falco.id }),
    ];

    const { container } = renderTracker(matches, falco);

    const tile = container.querySelector('[data-slot="fighter-record-tile"]');
    expect(tile).not.toBeNull();
    expect(tile!.closest('[data-slot="card"]')).not.toBeNull();
    expect(screen.getByText('Falco record')).toBeInTheDocument();
    expect(leadValue()).toBe('67%');
    const record =
      tile!.querySelector('[data-slot="record"]') ??
      container.querySelector('[data-slot="record"]');
    expect(record?.textContent).toMatch(/^2–1 · 67% · 3/);
    // No figure stated twice: the old three-figure row is gone.
    expect(screen.queryByText('Wins')).toBeNull();
    expect(screen.queryByText('Losses')).toBeNull();
    // The grid `StatRow` primitive is present — never the old collision class.
    expect(container.querySelector('[class*="justify-evenly"]')).toBeNull();
  });

  it('is never a centred, width-capped card (OOS-12a)', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true, fighter_id: falco.id })];
    const { container } = renderTracker(matches, falco);
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    for (const el of [container.firstElementChild as HTMLElement, card]) {
      expect(el.className).not.toMatch(/\bmx-auto\b|\bmax-w-sm\b|\btext-center\b/);
    }
    expect(container.querySelector('.text-center, .mx-auto, .max-w-sm')).toBeNull();
  });

  it('carries a DeltaChip that follows the page horizon (last30, then last90)', () => {
    const { container, rerenderHorizon } = renderTracker(horizonFixture(), falco, 'last30');
    const chip = () => container.querySelector('[data-slot="delta-chip"]');
    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toMatch(/last 30$/);
    // Only Falco's 100 games count: 70–30 all time.
    expect(leadValue()).toBe('70%');
    rerenderHorizon('last90');
    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toMatch(/last 90 days$/);
  });

  it('shows the no-match-data state when the selected fighter has no games, and renders no stat figures', () => {
    renderTracker([], mario);

    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
    expect(screen.queryByText('Wins')).not.toBeInTheDocument();
    expect(screen.queryByText('Losses')).not.toBeInTheDocument();
  });

  it('shows the no-match-data state when no fighter is selected at all', () => {
    const matches = [makeMatch({ id: '1', time: 1, win: true })];
    renderTracker(matches, undefined);

    expect(screen.getByText('No match data to report yet.')).toBeInTheDocument();
  });

  it('scopes the record to the selected fighter only, ignoring other fighters’ matches', () => {
    const luigi = SpriteList.find((s) => s.id === 10)!;
    const matches = [
      makeMatch({ id: '1', time: 1, win: true, fighter_id: mario.id }),
      makeMatch({ id: '2', time: 2, win: false, fighter_id: luigi.id }),
    ];

    const { container } = renderTracker(matches, mario);

    // Only mario's one win counts — the record is 1-0 (100%), not 1-1.
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="record"]')?.textContent).toMatch(/^1–0/);
  });

  it('declares no page-local Stat/HeroCard/StatBlock/SettingBlock component (UIX-04, §13.4)', () => {
    const selfPath = fileURLToPath(import.meta.url);
    const sourcePath = selfPath.replace(/\.test\.tsx$/, '.tsx');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/\bfunction\s+(Stat|HeroCard|StatBlock|SettingBlock)\b/);
  });
});
