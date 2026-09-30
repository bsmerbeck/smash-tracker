import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Match } from '@smash-tracker/shared';
import { MatchupStageTable } from './MatchupStageTable';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const BIG_BATTLEFIELD = { id: 2, name: 'Big Battlefield' };
const FINAL_DESTINATION = { id: 3, name: 'Final Destination' };
const POKEMON_STADIUM_2 = { id: 59, name: 'Pokémon Stadium 2' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };
const SMALL_BATTLEFIELD = { id: 113, name: 'Small Battlefield' };
const HOLLOW_BASTION = { id: 118, name: 'Hollow Bastion' };
/** Not present in `stagesById` — an id `getStageRecords` groups on its own (never folded into id 0), but still counts as "no recognised stage" per item 8. */
const UNRECOGNISED_STAGE = { id: 9999, name: 'Mystery Stage' };

const setDrillDownMock = vi.fn();

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 10,
    time: 1000,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function contextValue(): MatchupsContextValue {
  return {
    fighterSprites: [],
    fighter: undefined,
    setFighter: vi.fn(),
    opponent: undefined,
    setOpponent: vi.fn(),
    fighterUsageById: new Map(),
    opponentUsage: [],
    drillDownAxes: {},
    setDrillDown: setDrillDownMock,
  };
}

function renderTable(matches: Match[]) {
  return render(
    <MatchupsContext.Provider value={contextValue()}>
      <MatchupStageTable matchupMatches={matches} />
    </MatchupsContext.Provider>,
  );
}

function rowsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="comparison-bars-series"] > li'));
}

function onStage(stage: { id: number; name: string }, wins: number, losses: number): Match[] {
  const out: Match[] = [];
  for (let i = 0; i < wins; i++) {
    out.push(makeMatch({ id: `${stage.id}-w${i}`, map: stage, win: true, opponent: 'a' }));
  }
  for (let i = 0; i < losses; i++) {
    out.push(makeMatch({ id: `${stage.id}-l${i}`, map: stage, win: false, opponent: 'b' }));
  }
  return out;
}

/** Sketch 003 DEEP (brief section 4): seven stages + 30 unstaged games, 64-38 overall (62.7%). */
function deepMatches(): Match[] {
  return [
    ...onStage(BATTLEFIELD, 12, 6),
    ...onStage(POKEMON_STADIUM_2, 11, 4),
    ...onStage(TOWN_AND_CITY, 9, 6),
    ...onStage(FINAL_DESTINATION, 5, 3),
    ...onStage(SMALL_BATTLEFIELD, 3, 5),
    ...onStage(SMASHVILLE, 4, 1),
    ...onStage(HOLLOW_BASTION, 2, 1),
    ...Array.from({ length: 18 }, (_, i) =>
      makeMatch({ id: `ns-w${i}`, map: undefined, win: true }),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      makeMatch({ id: `ns-l${i}`, map: undefined, win: false }),
    ),
  ];
}

afterEach(() => {
  setDrillDownMock.mockClear();
  vi.restoreAllMocks();
});

describe('MatchupStageTable (39.1-46, sketch 003 A stageCard: series rows)', () => {
  it('series-rows: titles the card "Stage breakdown" with the "most games first · all time" meta', () => {
    renderTable(deepMatches());
    expect(screen.getByText('Stage breakdown')).toBeInTheDocument();
    expect(screen.getByText('most games first · all time')).toBeInTheDocument();
  });

  it('series-rows: renders one series row per recognised stage, most games first, ties by stage id, and no <table>', () => {
    const { container } = renderTable(deepMatches());
    expect(container.querySelector('table')).toBeNull();
    const rows = rowsOf(container);
    expect(
      rows.map((row) => row.querySelector('[data-slot="comparison-bar-label"]')!.textContent),
    ).toEqual([
      'Battlefield',
      'Pokémon Stadium 2',
      'Town and City',
      'Final Destination',
      'Small Battlefield',
      'Smashville',
      'Hollow Bastion',
    ]);
    // record · rate · n for a row at or above the floor.
    expect(within(rows[0]!).getByText('12–6')).toBeInTheDocument();
    expect(rows[0]!.textContent).toContain('67%');
    expect(rows[0]!.textContent).toContain('18');
  });

  it('series-rows: every row is a stage drill — it writes the stage axis and scrolls to the results anchor', async () => {
    const user = userEvent.setup();
    const anchor = document.createElement('div');
    anchor.id = MATCHUP_TABLE_ANCHOR_ID;
    document.body.appendChild(anchor);
    const scroll = vi.fn();
    anchor.scrollIntoView = scroll;
    const { container } = renderTable(deepMatches());
    const buttons = within(container).getAllByRole('button');
    expect(buttons).toHaveLength(7);
    await user.click(within(container).getByRole('button', { name: /Smashville/ }));
    expect(setDrillDownMock).toHaveBeenCalledWith({ stageId: 83 });
    expect(scroll).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('series-rows: a stage at exactly the 3-game floor is a normal row; under 3 games is sub-floor (grey, no rate)', () => {
    const matches = [
      ...onStage(BATTLEFIELD, 3, 3),
      ...onStage(HOLLOW_BASTION, 2, 1),
      ...onStage(BIG_BATTLEFIELD, 1, 1),
    ];
    const { container } = renderTable(matches);
    const fills = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-fill"]'),
    );
    expect(fills).toHaveLength(3);
    // Battlefield (6) and Hollow Bastion (3, AT the floor) are identity blue.
    expect(fills[0]!.style.backgroundColor).toBe('var(--viz-series-1)');
    expect(fills[1]!.style.backgroundColor).toBe('var(--viz-series-1)');
    // Big Battlefield (2 games) is sub-floor: strong de-emphasis, no rate printed.
    expect(fills[2]!.style.backgroundColor).toBe('var(--viz-context-strong)');
    const subRow = rowsOf(container)[2]!;
    expect(subRow.textContent).not.toContain('%');
  });

  it('series-rows: thin data (every stage under 3 games) renders every row sub-floor', () => {
    const matches = [
      ...onStage(BATTLEFIELD, 0, 2),
      ...onStage(BIG_BATTLEFIELD, 1, 1),
      ...onStage(SMASHVILLE, 1, 0),
    ];
    const { container } = renderTable(matches);
    const fills = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-fill"]'),
    );
    expect(fills).toHaveLength(3);
    for (const fill of fills) {
      expect(fill.style.backgroundColor).toBe('var(--viz-context-strong)');
    }
  });

  it('series-rows: draws the all-time reference tick at the pairing rate and a legend naming it and the grey bar', () => {
    const { container } = renderTable(deepMatches());
    const ticks = container.querySelectorAll<HTMLElement>('[data-slot="comparison-bar-reference"]');
    expect(ticks).toHaveLength(7);
    // 64-38 = 62.7% over ALL games, unstaged included (sketch reference 62.7).
    expect(parseFloat(ticks[0]!.style.left)).toBeCloseTo(62.7, 1);
    const legend = container.querySelector('[data-slot="stage-table-legend"]')!;
    expect(legend.textContent).toContain('63% all time');
    expect(legend.textContent).toContain('grey bar = under 3 games');
  });

  it('lists only the recognised stage, discloses the no-map + unrecognised-id games in one footnote, and the rows plus footnote fully account for every game', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf1', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf2', map: BATTLEFIELD, win: false }),
      makeMatch({ id: 'nomap0', map: undefined }),
      makeMatch({ id: 'nomap1', map: undefined }),
      makeMatch({ id: 'unk0', map: UNRECOGNISED_STAGE }),
    ];
    const { container } = renderTable(matches);

    const rows = rowsOf(container);
    expect(rows.length).toBe(1);
    expect(within(rows[0]!).getByText('Battlefield')).toBeInTheDocument();

    expect(screen.queryByText(/\bUNK\b/)).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();

    const footnote = container.querySelector('[data-slot="stage-table-no-stage"]');
    expect(footnote).toBeInTheDocument();
    expect(footnote!.textContent).toBe('3 games with no stage recorded');

    // Row totals (wins + losses parsed off the row's own record) plus the
    // footnote's own count equal the pairing's full game count.
    const rowGames = rows.reduce((sum, row) => {
      const [wins, losses] = (within(row).getByText(/^\d+–\d+$/).textContent ?? '0–0')
        .split('–')
        .map(Number);
      return sum + (wins ?? 0) + (losses ?? 0);
    }, 0);
    expect(rowGames + 3).toBe(matches.length);
  });

  it('uses the singular footnote for exactly one unstaged game', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'nomap0', map: undefined }),
    ];
    const { container } = renderTable(matches);

    const footnote = container.querySelector('[data-slot="stage-table-no-stage"]');
    expect(footnote?.textContent).toBe('1 game with no stage recorded');
  });

  it('renders only the footnote (no rows, no legend, no empty copy) when every game is unstaged', () => {
    const matches: Match[] = [
      makeMatch({ id: 'nomap0', map: undefined }),
      makeMatch({ id: 'nomap1', map: undefined }),
      makeMatch({ id: 'nomap2', map: undefined }),
    ];
    const { container } = renderTable(matches);

    expect(rowsOf(container)).toHaveLength(0);
    expect(container.querySelector('[data-slot="stage-table-legend"]')).toBeNull();
    expect(container.querySelector('[data-slot="stage-table-no-stage"]')).toBeInTheDocument();
    expect(screen.queryByText('No matches recorded for this matchup yet.')).not.toBeInTheDocument();
  });

  it('renders the existing empty copy and no footnote when there are no games at all', () => {
    const { container } = renderTable([]);

    expect(screen.getByText('No matches recorded for this matchup yet.')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="stage-table-no-stage"]')).toBeNull();
  });

  it('breaks an equal-total tie deterministically by ascending stage id', () => {
    const matches: Match[] = [
      makeMatch({ id: 'bb0', map: BIG_BATTLEFIELD, win: true }),
      makeMatch({ id: 'bb1', map: BIG_BATTLEFIELD, win: false }),
      makeMatch({ id: 'bf0', map: BATTLEFIELD, win: true }),
      makeMatch({ id: 'bf1', map: BATTLEFIELD, win: false }),
    ];
    const { container } = renderTable(matches);

    const rows = rowsOf(container);
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain('Battlefield');
    expect(rows[1]!.textContent).toContain('Big Battlefield');
    // The Big Battlefield row is the second, not the first.
    expect(rows[0]!.textContent).not.toContain('Big Battlefield');
  });
});
