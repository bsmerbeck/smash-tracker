import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AdvisorRetrospective } from './AdvisorRetrospective';
import { buildRetrospective } from '../lib/retrospective';

const BATTLEFIELD = { id: 1, name: 'Battlefield' };
const SMALL_BATTLEFIELD = { id: 113, name: 'Small Battlefield' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const NO_SELECTION = { id: 0, name: 'no selection' };
/** Not tournament-legal under the house default ruleset — exercises the ADV-02/D-14 outside-the-ruleset reason. */
const OFF_RULESET_STAGE = { id: 2, name: 'Big Battlefield' };

function makeEntry(overrides: Partial<TournamentEntry> = {}): TournamentEntry {
  return {
    eventId: 1,
    eventName: 'Ultimate Singles',
    firstSetAt: 1_000_000,
    lastSetAt: 2_000_000,
    setsPlayed: 1,
    ...overrides,
  };
}

let idCounter = 0;
function makeMatch(overrides: Partial<Match> & Pick<Match, 'time' | 'win'>): Match {
  idCounter += 1;
  return {
    id: `m${idCounter}`,
    fighter_id: 1,
    opponent_id: 10,
    map: BATTLEFIELD,
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

function renderRetro(allMatches: Match[], entryMatches: Match[], entry: TournamentEntry) {
  const retrospective = buildRetrospective(allMatches, entryMatches, entry);
  return render(
    <TooltipProvider>
      <AdvisorRetrospective retrospective={retrospective} />
    </TooltipProvider>,
  );
}

describe('AdvisorRetrospective', () => {
  it('shows the honest all-no-data empty state when nothing is classifiable', () => {
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: NO_SELECTION,
      externalId: 'sgg:1:g1',
    });

    renderRetro([game], [game], entry);

    expect(
      screen.getByText('Not enough pre-tournament data to grade these picks.'),
    ).toBeInTheDocument();
  });

  it('shows a no-games empty state when the event has no games at all', () => {
    const entry = makeEntry();
    renderRetro([], [], entry);
    expect(screen.getByText('No games recorded for this event yet.')).toBeInTheDocument();
  });

  it('renders the adherence summary with both win-rate halves when both exist', () => {
    const pre = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      ),
    ];
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const followedGame = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:1:g1',
    });

    renderRetro([...pre, followedGame], [followedGame], entry);

    expect(screen.getByText(/Advisor adherence: 100% of classifiable picks/)).toBeInTheDocument();
    expect(screen.getByText(/followed picks won 100%/)).toBeInTheDocument();
  });

  it('renders per-set rows with a result badge', () => {
    const pre = Array.from({ length: 5 }, (_, i) =>
      makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
    );
    const entry = makeEntry({ firstSetAt: 1_000_000 });
    const game = makeMatch({
      time: 1_500_000,
      win: true,
      map: BATTLEFIELD,
      externalId: 'sgg:42:g1',
      roundText: 'Winners Finals',
    });

    renderRetro([...pre, game], [game], entry);

    expect(screen.getByText('Winners Finals')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
  });

  describe('ADV-02/D-14: visible chip, reason and takeaway (no hover or focus needed)', () => {
    it('renders the classification chip, reason line and takeaway line as plain visible text', () => {
      const pre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      );
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const game = makeMatch({
        time: 1_500_000,
        win: true,
        map: BATTLEFIELD,
        externalId: 'sgg:1:g1',
      });

      // No userEvent.hover/focus anywhere in this test — the queries below
      // must succeed against the plain, un-interacted-with render.
      renderRetro([...pre, game], [game], entry);

      expect(screen.getByText('Followed advisor')).toBeInTheDocument();
      expect(
        screen.getByText("Battlefield — followed the advisor's call (Won)"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Followed the pick and won — good sign to keep this stage in the gameplan.',
        ),
      ).toBeInTheDocument();
    });

    it('grades a game on a bottom-ranked stage as against, with a reason naming the recommended picks', () => {
      const pre = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
        ),
        ...Array.from({ length: 4 }, (_, i) =>
          makeMatch({ time: 200 + i, win: true, map: TOWN_AND_CITY }),
        ),
        makeMatch({ time: 204, win: false, map: TOWN_AND_CITY }),
        ...Array.from({ length: 3 }, (_, i) =>
          makeMatch({ time: 300 + i, win: true, map: SMASHVILLE }),
        ),
        makeMatch({ time: 303, win: false, map: SMASHVILLE }),
        makeMatch({ time: 304, win: false, map: SMASHVILLE }),
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ time: 400 + i, win: false, map: SMALL_BATTLEFIELD }),
        ),
      ];
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const game = makeMatch({
        time: 1_500_000,
        win: false,
        map: SMALL_BATTLEFIELD,
        externalId: 'sgg:1:g1',
      });

      renderRetro([...pre, game], [game], entry);

      expect(screen.getByText('Went against advisor')).toBeInTheDocument();
      expect(
        screen.getByText("Small Battlefield — against the advisor's call (Lost)"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Went against the pick and lost — worth trying the recommended stage next time.',
        ),
      ).toBeInTheDocument();
    });

    it('grades a game played outside the event ruleset as no-stance, with a distinct reason from an ordinary no-stance game', () => {
      const pre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      );
      const entry = makeEntry({ firstSetAt: 1_000_000 });
      const game = makeMatch({
        time: 1_500_000,
        win: true,
        map: OFF_RULESET_STAGE,
        externalId: 'sgg:1:g1',
      });

      renderRetro([...pre, game], [game], entry);

      expect(screen.getByText('No advisor stance')).toBeInTheDocument();
      expect(
        screen.getByText(
          "Big Battlefield — not legal under this event's ruleset, so the advisor never ranked it (Won)",
        ),
      ).toBeInTheDocument();
    });

    it('reuses the existing classification style treatments unedited (emerald/destructive/muted/dashed)', () => {
      const followedPre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      );
      const followedGame = makeMatch({
        time: 1_500_000,
        win: true,
        map: BATTLEFIELD,
        externalId: 'sgg:1:g1',
      });
      const { unmount: unmountFollowed } = renderRetro(
        [...followedPre, followedGame],
        [followedGame],
        makeEntry({ firstSetAt: 1_000_000 }),
      );
      expect(screen.getByText('Followed advisor').parentElement?.className).toContain(
        'bg-emerald-600',
      );
      unmountFollowed();

      const outsideRulesetPre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      );
      const outsideRulesetGame = makeMatch({
        time: 1_500_000,
        win: true,
        map: OFF_RULESET_STAGE,
        externalId: 'sgg:1:g1',
      });
      const { unmount: unmountNeutral } = renderRetro(
        [...outsideRulesetPre, outsideRulesetGame],
        [outsideRulesetGame],
        makeEntry({ firstSetAt: 1_000_000 }),
      );
      expect(screen.getByText('No advisor stance').parentElement?.className).toContain('bg-muted');
      unmountNeutral();

      const noDataGame = makeMatch({
        time: 1_500_000,
        win: true,
        map: NO_SELECTION,
        externalId: 'sgg:1:g1',
      });
      const { unmount: unmountNoData } = renderRetro(
        [noDataGame],
        [noDataGame],
        makeEntry({ firstSetAt: 1_000_000 }),
      );
      expect(screen.getByText('Not enough data').parentElement?.className).toContain(
        'border-dashed',
      );
      unmountNoData();
    });

    it('discloses the ruleset preset name and the grading basis in the card description', () => {
      const entry = makeEntry();
      renderRetro([], [], entry);
      expect(screen.getByText(/Graded under House default \(SSBU\)/)).toBeInTheDocument();
      expect(
        screen.getByText(
          'Every stage this ruleset makes legal was treated as available — per-game bans and strikes were never recorded.',
        ),
      ).toBeInTheDocument();
    });

    it('renders one of six distinct takeaway strings per (classification, result) pair', () => {
      const banPre = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
        ),
        ...Array.from({ length: 4 }, (_, i) =>
          makeMatch({ time: 200 + i, win: true, map: TOWN_AND_CITY }),
        ),
        makeMatch({ time: 204, win: false, map: TOWN_AND_CITY }),
        ...Array.from({ length: 3 }, (_, i) =>
          makeMatch({ time: 300 + i, win: true, map: SMASHVILLE }),
        ),
        makeMatch({ time: 303, win: false, map: SMASHVILLE }),
        makeMatch({ time: 304, win: false, map: SMASHVILLE }),
        ...Array.from({ length: 5 }, (_, i) =>
          makeMatch({ time: 400 + i, win: false, map: SMALL_BATTLEFIELD }),
        ),
      ];
      const followedPre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ time: 100 + i, win: true, map: BATTLEFIELD }),
      );

      const cases: Array<{
        name: string;
        pre: Match[];
        game: Match;
        expectedTakeaway: string;
      }> = [
        {
          name: 'followed + win',
          pre: followedPre,
          game: makeMatch({ time: 1_500_000, win: true, map: BATTLEFIELD, externalId: 'sgg:1:g1' }),
          expectedTakeaway:
            'Followed the pick and won — good sign to keep this stage in the gameplan.',
        },
        {
          name: 'followed + loss',
          pre: followedPre,
          game: makeMatch({
            time: 1_500_000,
            win: false,
            map: BATTLEFIELD,
            externalId: 'sgg:1:g1',
          }),
          expectedTakeaway:
            "Followed the pick and lost — the recommendation didn't hold up this time.",
        },
        {
          name: 'against + win',
          pre: banPre,
          game: makeMatch({
            time: 1_500_000,
            win: true,
            map: SMALL_BATTLEFIELD,
            externalId: 'sgg:1:g1',
          }),
          expectedTakeaway: 'Went against the pick and won — the call may need more data.',
        },
        {
          name: 'against + loss',
          pre: banPre,
          game: makeMatch({
            time: 1_500_000,
            win: false,
            map: SMALL_BATTLEFIELD,
            externalId: 'sgg:1:g1',
          }),
          expectedTakeaway:
            'Went against the pick and lost — worth trying the recommended stage next time.',
        },
        {
          name: 'no-stance (outside the ruleset)',
          pre: followedPre,
          game: makeMatch({
            time: 1_500_000,
            win: true,
            map: OFF_RULESET_STAGE,
            externalId: 'sgg:1:g1',
          }),
          expectedTakeaway: 'No strong recommendation either way for this stage.',
        },
        {
          name: 'no-data',
          pre: [],
          game: makeMatch({
            time: 1_500_000,
            win: true,
            map: NO_SELECTION,
            externalId: 'sgg:1:g1',
          }),
          expectedTakeaway: 'Not enough pre-tournament data to grade this pick.',
        },
      ];

      for (const { pre, game, expectedTakeaway } of cases) {
        const { unmount } = renderRetro(
          [...pre, game],
          [game],
          makeEntry({ firstSetAt: 1_000_000 }),
        );
        expect(screen.getByText(expectedTakeaway)).toBeInTheDocument();
        unmount();
      }

      // All six are genuinely distinct strings, not one representative case.
      expect(new Set(cases.map((c) => c.expectedTakeaway)).size).toBe(cases.length);
    });
  });
});
