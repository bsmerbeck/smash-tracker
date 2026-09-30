import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { CounterpickAdvisor } from './CounterpickAdvisor';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { MatchupsContext, type MatchupsContextValue } from '../MatchupsContext';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';
import { TooltipProvider } from '@/components/ui/tooltip';

// Plan 39.1-47 (segmented-set-state, PD-47-1, sketch 003 B `segControls`): the
// "Change assumption" popover trigger is replaced by two segmented controls
// (Phase, Role) plus a muted "stages played · bans" link that opens the
// prior-stages / bans checklists. The link's accessible name is its visible
// text (WCAG 2.5.3); the phase / role radios moved out of the popover.
const PLAYED_BANS_LINK = 'stages played · bans';
const ROLE_PICKING = 'Picking (you lost)';
const ROLE_BANNING = 'Banning (you won)';

/**
 * D-07/Phase 38-04: `CounterpickAdvisor` now reads `useMatchupsContext()` for
 * its bar-click drill-down, writing the stage axis via `setDrillDown`.
 * `setDrillDownMock` is a shared mock so click tests can assert on the exact
 * axes it was called with; every other field is inert filler this component
 * never reads.
 */
const setDrillDownMock = vi.fn();

function baseMatchupsContextValue(
  overrides: Partial<MatchupsContextValue> = {},
): MatchupsContextValue {
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
    ...overrides,
  };
}

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
  },
}));

/**
 * D-13 (plan 37-05, layer 2 — "one binding, observed"): a partial mock of
 * `@/lib/stats` that records the exact `minMatches` argument
 * `buildStageEvidence` was called with, then delegates to the real
 * implementation. This is the assertion that fails the moment the header is
 * fed by anything other than the argument the engine received — comparing a
 * value to itself (the old regression this replaces) can never fail.
 */
let recordedMinMatches: number | undefined;

vi.mock('@/lib/stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stats')>();
  return {
    ...actual,
    buildStageEvidence: (input: Parameters<typeof actual.buildStageEvidence>[0]) => {
      recordedMinMatches = input.minMatches;
      return actual.buildStageEvidence(input);
    },
  };
});

/**
 * D-13 (plan 37-05, layers 3-4 — "driven divergence"): wraps the REAL
 * `useMinStageMatches` hook (still calling it, so its subscription machinery
 * stays intact) but overrides its returned value when a test sets
 * `minGamesOverride` — the seam that lets a test drive the threshold SOURCE
 * to a value the real storage boundary (`isValidMinStageMatches`) can never
 * produce (7, or a sub-floor 1).
 */
let minGamesOverride: number | undefined;

vi.mock('@/hooks/useMinStageMatches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMinStageMatches')>();
  return {
    ...actual,
    useMinStageMatches: (...args: Parameters<typeof actual.useMinStageMatches>) => {
      const real = actual.useMinStageMatches(...args);
      return minGamesOverride !== undefined ? ([minGamesOverride, real[1]] as const) : real;
    },
  };
});

/**
 * Phase 35-03 (NEW-M1): `CounterpickAdvisor` now reads the shared per-subject
 * threshold via `useMinStageMatches`, which calls `useEffectiveSubject()` —
 * Router-context-dependent. Every render in this file must be wrapped.
 */
function renderAdvisor(
  matchupMatches: Match[],
  contextOverrides: Partial<MatchupsContextValue> = {},
) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={['/matchups']}>
        <MatchupsContext.Provider value={baseMatchupsContextValue(contextOverrides)}>
          <div id={MATCHUP_TABLE_ANCHOR_ID} />
          <CounterpickAdvisor matchupMatches={matchupMatches} />
        </MatchupsContext.Provider>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

/**
 * Phase 36 (R1-HIGH-1): signed-in variant, so a persisted `minStageMatches`
 * value under `test-uid` is actually read — proving the engine's floor
 * enforcement rather than merely the unauthenticated default of 3.
 */
function renderAdvisorAsSignedInUser(matchupMatches: Match[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/matchups']}>
          <AuthProvider>
            <MatchupsContext.Provider value={baseMatchupsContextValue()}>
              <CounterpickAdvisor matchupMatches={matchupMatches} />
            </MatchupsContext.Provider>
          </AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Real stage ids/names from packages/shared/src/stageData.ts — CounterpickAdvisor
// looks the name up by id via `stagesById`, so test fixtures must use ids that
// actually resolve (a synthetic id would render as "Unknown stage").
const BATTLEFIELD = { id: 1, name: 'Battlefield' };
// Plan 37-05 (R1-BLOCKER-5): id 2 ("Big Battlefield") is NOT a member of
// `TOURNAMENT_LEGAL_STAGE_IDS`, so it is illegal under every resolution of
// the default ruleset — the legality filter this plan adds would empty the
// Ban group in every case below that used to rely on it. `SMALL_BATTLEFIELD`
// (id 113) replaces it as the "worst stage" fixture in the three cases that
// depended on it: it plays the same structural role (a legal starter,
// distinct from the four stages the rest of this file already uses) while
// staying inside the active ruleset. `OFF_RULESET_STAGE` below keeps id 2
// alive as the fixture that exercises the case the legality filter actually
// earns.
const SMALL_BATTLEFIELD = { id: 113, name: 'Small Battlefield' };
const OFF_RULESET_STAGE = { id: 2, name: 'Big Battlefield' };
const FINAL_DESTINATION = { id: 3, name: 'Final Destination' };
const SMASHVILLE = { id: 83, name: 'Smashville' };
const TOWN_AND_CITY = { id: 85, name: 'Town and City' };
// A real DEFAULT_RULESET counterpick (not a starter) — legal from game two
// onward only, the complementary half of the off-ruleset case above.
const LYLAT_CRUISE = { id: 56, name: 'Lylat Cruise' };

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

function matchesOnStage(
  stage: { id: number; name: string },
  wins: number,
  losses: number,
): Match[] {
  const result: Match[] = [];
  for (let i = 0; i < wins; i++) {
    result.push(makeMatch({ id: `${stage.name}-w${i}`, map: stage, win: true }));
  }
  for (let i = 0; i < losses; i++) {
    result.push(makeMatch({ id: `${stage.name}-l${i}`, map: stage, win: false }));
  }
  return result;
}

describe('CounterpickAdvisor', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    recordedMinMatches = undefined;
    minGamesOverride = undefined;
  });

  afterEach(() => {
    minGamesOverride = undefined;
  });

  it('shows a gather-more-data hint when no stage has the minimum sample size', () => {
    // Phase 36 (D-05, EVID-06): the bespoke "Gather more data" copy is
    // replaced by the shared abstained sentence, which names the exact
    // number of additional games needed rather than a generic nudge.
    renderAdvisor(matchesOnStage(BATTLEFIELD, 1, 0));
    expect(screen.getByText(/Not enough data yet.*2 more games needed/)).toBeInTheDocument();
    expect(screen.queryByText('Pick these')).not.toBeInTheDocument();
  });

  it('excludes stages below the shared default 3-game threshold from picks/bans', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0), // qualifies, best
      ...matchesOnStage(TOWN_AND_CITY, 2, 0), // below threshold — excluded
    ];
    renderAdvisor(matches);
    expect(screen.getByText('Pick these')).toBeInTheDocument();
    expect(screen.queryByText(/Town and City/)).not.toBeInTheDocument();
  });

  it('ranks the best stage first under "Pick these"', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0), // 100%, n=5 — best
      ...matchesOnStage(TOWN_AND_CITY, 3, 2), // 60%, n=5
    ];
    renderAdvisor(matches);

    const pickSection = screen.getByText('Pick these').closest('div')!;
    const items = pickSection.querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Battlefield');
  });

  it('splits picks and bans without overlap when there are exactly enough qualifying stages', () => {
    // 4 qualifying stages: top 3 -> picks, remaining 1 -> bans.
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0),
      ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ...matchesOnStage(SMASHVILLE, 3, 2),
      ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5),
    ];
    renderAdvisor(matches);

    const pickSection = screen.getByText('Pick these').closest('div')!;
    const banSection = screen.getByText('Ban / avoid these').closest('div')!;

    expect(pickSection.querySelectorAll('li')).toHaveLength(3);
    expect(banSection.querySelectorAll('li')).toHaveLength(1);
    expect(banSection.textContent).toContain('Small Battlefield');
    expect(pickSection.textContent).not.toContain('Small Battlefield');
  });

  it('does not show a bans section when every qualifying stage is already a pick', () => {
    const matches = [...matchesOnStage(BATTLEFIELD, 5, 0), ...matchesOnStage(TOWN_AND_CITY, 4, 1)];
    renderAdvisor(matches);

    expect(screen.getByText('Pick these')).toBeInTheDocument();
    expect(screen.queryByText('Ban / avoid these')).not.toBeInTheDocument();
  });

  it('shows worst stage first under "Ban / avoid these"', () => {
    const matches = [
      ...matchesOnStage(BATTLEFIELD, 5, 0),
      ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ...matchesOnStage(SMASHVILLE, 2, 3), // worse than Small Battlefield below
      ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5), // worst
    ];
    renderAdvisor(matches);

    const banSection = screen.getByText('Ban / avoid these').closest('div')!;
    const items = banSection.querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Small Battlefield');
  });

  it('shows the record, rate, and sample size for each stage row', () => {
    const matches = matchesOnStage(BATTLEFIELD, 3, 2);
    renderAdvisor(matches);
    // Plan 39.1-47: the row is a series row — its record, rate and sample are
    // one screen-reader sentence (en dash, `W–L · rate% · n`) beside the
    // drawn Record + confidence glyph (was the `3-2 (60% over 5)` label).
    expect(screen.getByText('3–2 · 60% · 5')).toBeInTheDocument();
  });

  // Phase 36 (D-05/D-07 regression net): the owner's Town-and-City /
  // Final-Destination finding — a 2-0 record must never appear under Pick
  // or Ban, even when the persisted per-subject threshold is 1 (the state a
  // user carries into wave 1, before plan 36-02 shrinks the option list).
  it('hides a 2-0 stage from both Pick and Ban entirely, even with a persisted min-matches of 1', async () => {
    setMockUser(makeMockUser());
    window.localStorage.setItem(
      analyticsSelectionStorageKey('test-uid', null),
      JSON.stringify({ minStageMatches: 1 }),
    );
    const TOWN_AND_CITY_2_0 = matchesOnStage(TOWN_AND_CITY, 2, 0); // below the floor, despite a perfect record
    const matches = [
      ...TOWN_AND_CITY_2_0,
      ...matchesOnStage(BATTLEFIELD, 6, 2), // proven, qualifies -> pick
      ...matchesOnStage(SMASHVILLE, 4, 1), // qualifies -> pick
      ...matchesOnStage(FINAL_DESTINATION, 3, 2), // qualifies -> pick (exactly 3 picks)
      ...matchesOnStage(SMALL_BATTLEFIELD, 1, 4), // qualifies, worst record -> ban
    ];
    renderAdvisorAsSignedInUser(matches);

    await waitFor(() => expect(screen.getByText('Pick these')).toBeInTheDocument());
    expect(screen.queryByText(/Town and City/)).not.toBeInTheDocument();
    expect(screen.getByText('Ban / avoid these')).toBeInTheDocument();
    // Confirm the 2-0 stage isn't hiding under the ban heading either.
    const banSection = screen.getByText('Ban / avoid these').closest('div')!;
    expect(banSection.textContent).not.toContain('Town and City');
  });

  it('shows the abstained sentence with the exact remaining-games count when no stage reaches the floor', () => {
    renderAdvisor(matchesOnStage(BATTLEFIELD, 2, 0));
    expect(screen.getByText(/Not enough data yet.*1 more game needed\./)).toBeInTheDocument();
    expect(screen.queryByText('Pick these')).not.toBeInTheDocument();
    expect(screen.queryByText('Ban / avoid these')).not.toBeInTheDocument();
  });

  // Plan 37-05 (EVID-05, ADV-01): the assertion the legality filter earns,
  // distinct from the sample-size gate above — a stage with a fully
  // qualifying record but an id OUTSIDE the active ruleset never reaches
  // either bucket, no matter how good its record is.
  it('excludes a stage with a qualifying record on an id outside the active ruleset', () => {
    const matches = [
      ...matchesOnStage(OFF_RULESET_STAGE, 5, 0), // 100%, would rank #1 if legal — illegal id 2
      ...matchesOnStage(BATTLEFIELD, 5, 0),
      ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ...matchesOnStage(SMASHVILLE, 3, 2),
    ];
    renderAdvisor(matches);

    expect(screen.getByText('Pick these')).toBeInTheDocument();
    expect(screen.queryByText(/Big Battlefield/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ban / avoid these')).not.toBeInTheDocument();
    const pickSection = screen.getByText('Pick these').closest('div')!;
    expect(pickSection.querySelectorAll('li')).toHaveLength(3);
  });

  it('segmented-set-state: the toolbar sample cue is gone (PD-47-3) — one confidence glyph per row, no "N games · confidence" chip', () => {
    const matches = matchesOnStage(BATTLEFIELD, 3, 2);
    const { container } = renderAdvisor(matches);
    // REWRITTEN from "exactly one sample cue element in the toolbar": the
    // SampleCue chip folded into the meta line; the evidence now lives on each
    // row as the tier glyph, so no chip-shaped "5 games · medium confidence" text exists.
    expect(screen.queryAllByText(/games? · .* confidence/)).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="comparison-bars-series"] li')).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-slot="comparison-bars-series"] [role="img"]'),
    ).toHaveLength(1);
  });

  describe('D-13 regression: the displayed threshold and the computed threshold are one binding', () => {
    it('layer 2 — one binding, observed: the recorded minMatches equals the integer parsed out of the rendered threshold line', () => {
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      // Plan 39.1-47 (PD-47-3): the threshold sentence folded into the card's meta
      // line; the binding under test is unchanged (the rendered number IS the one
      // the engine received).
      const thresholdEl = screen.getByText(/min \d+ games? per stage/);
      const parsed = Number(thresholdEl.textContent?.match(/min (\d+)/)?.[1]);
      expect(recordedMinMatches).toBe(parsed);
      expect(parsed).toBe(3);
    });

    it('layer 3 — driven divergence ABOVE the floor: the header renders 7 and the gate admits a 7-game stage while excluding a 6-game one', () => {
      minGamesOverride = 7; // a value MIN_STAGE_MATCHES_OPTIONS can never produce
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 7, 0), // exactly at the driven threshold
        ...matchesOnStage(TOWN_AND_CITY, 6, 0), // one game short
      ];
      renderAdvisor(matches);

      expect(
        screen.getByText('Counterpick Advisor · all time · min 7 games per stage'),
      ).toBeInTheDocument();
      expect(recordedMinMatches).toBe(7);
      const pickSection = screen.getByText('Pick these').closest('div')!;
      expect(pickSection.textContent).toContain('Battlefield');
      expect(screen.queryByText(/Town and City/)).not.toBeInTheDocument();
    });

    it('layer 4 — driven divergence BELOW the floor: the header renders the floored 3, not the raw 1, and the gate follows the floored value', () => {
      minGamesOverride = 1; // unreachable through the real picker
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 3, 0), // exactly at the floor
        ...matchesOnStage(TOWN_AND_CITY, 2, 0), // one game short of the floor
      ];
      renderAdvisor(matches);

      // effectiveFloor(1) === 3 while effectiveFloor(7) === 7 — this is the
      // ONLY input where reading the hook raw and reading `advisorThreshold`
      // diverge, which is why it's the assertion that actually proves the
      // header is wired to the binding rather than to the hook.
      expect(
        screen.getByText('Counterpick Advisor · all time · min 3 games per stage'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/min 1 game per stage/)).not.toBeInTheDocument();
      expect(recordedMinMatches).toBe(3);
      const pickSection = screen.getByText('Pick these').closest('div')!;
      expect(pickSection.textContent).toContain('Battlefield');
      expect(screen.queryByText(/Town and City/)).not.toBeInTheDocument();
    });
  });

  describe('Task 2: ruleset disclosure and editable set state (D-11, D-12, EVID-04, EVID-05)', () => {
    const ASSUMPTION_GAME1 = 'Assuming Game 1 · Striking · no stages played yet, no bans';

    it('renders the ruleset control in the assumption line even when the claim is abstained', () => {
      renderAdvisor(matchesOnStage(BATTLEFIELD, 1, 0)); // abstained fixture
      expect(
        screen.getByRole('button', {
          name: 'View the ruleset assumption behind these stage recommendations',
        }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Not enough data yet/)).toBeInTheDocument();
    });

    it('segmented-set-state: ONE assumption line holds the ruleset control and the composed sentence, stated exactly once', () => {
      const { container } = renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      // REWRITTEN from "the trigger shows the short 'Change assumption' label":
      // there is no assumption trigger any more — the sentence is the always-
      // visible line, sitting beside the ruleset disclosure, never on a control.
      const line = screen.getByTestId('set-state-assumption-line');
      expect(line.textContent).toBe(ASSUMPTION_GAME1);
      expect(screen.getAllByText(ASSUMPTION_GAME1)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Change assumption' })).toBeNull();
      const rulesetButton = screen.getByRole('button', {
        name: 'View the ruleset assumption behind these stage recommendations',
      });
      const assumptionRow = line.parentElement!;
      expect(assumptionRow.contains(rulesetButton)).toBe(true);
      expect(assumptionRow.closest('[data-slot="set-state-segments"]')).toBeNull();
      expect(container.querySelector('[data-slot="counterpick-controls"]')).toBeNull();
    });

    it('segmented-set-state: the card is a region named by its top line — suggestion chip plus the meta line', () => {
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      const region = screen.getByRole('region', {
        name: 'Counterpick Advisor · all time · min 3 games per stage',
      });
      expect(within(region).getByText('Suggestion')).toBeInTheDocument();
    });

    it('segmented-set-state: an abstained card keeps the dashed locked chip, the sentence and a count meter', () => {
      const { container } = renderAdvisor(matchesOnStage(BATTLEFIELD, 2, 0));
      expect(screen.getByText('Suggestion · Locked')).toBeInTheDocument();
      expect(screen.getByText(/Not enough data yet.*1 more game needed\./)).toBeInTheDocument();
      const meter = container.querySelector('[role="img"][aria-label="2 of 3 games"]');
      expect(meter).not.toBeNull();
      // The controls still render (EVID-05 always-visible): the assumption is what
      // computed the abstention.
      expect(container.querySelector('[data-slot="set-state-segments"]')).not.toBeNull();
      expect(screen.getByTestId('set-state-assumption-line')).toBeInTheDocument();
    });

    it('segmented-set-state: Phase and Role are two labelled radiogroups in [data-slot="set-state-segments"], with the popover link beside them', () => {
      const { container } = renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      const segments = container.querySelector('[data-slot="set-state-segments"]') as HTMLElement;
      expect(segments).not.toBeNull();
      expect(within(segments).getAllByRole('radiogroup')).toHaveLength(2);
      const phase = within(segments).getByRole('radiogroup', { name: 'Phase' });
      const role = within(segments).getByRole('radiogroup', { name: 'Role' });
      expect(within(phase).getByRole('radio', { name: 'Game 1' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(within(phase).getByRole('radio', { name: 'Game 2+' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(within(role).getAllByRole('radio')).toHaveLength(2);
      expect(within(segments).getByRole('button', { name: PLAYED_BANS_LINK })).toBeInTheDocument();
    });

    it('segmented-set-state: at Game 1 "Striking" is pressed and both role options are unavailable, with the reason on hover', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      const striking = screen.getByRole('radio', { name: 'Striking' });
      const picking = screen.getByRole('radio', { name: ROLE_PICKING });
      expect(striking).toHaveAttribute('aria-checked', 'true');
      expect(striking).toHaveAttribute('aria-disabled', 'true');
      expect(picking).toHaveAttribute('aria-disabled', 'true');
      await user.hover(picking);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Roles apply from Game 2');
      await user.click(picking);
      expect(picking).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByTestId('set-state-assumption-line').textContent).toBe(ASSUMPTION_GAME1);
    });

    it('segmented-set-state: at Game 2+ the roles read "Banning (you won)" (striking) and "Picking (you lost)" (picking) and are available', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      const banning = screen.getByRole('radio', { name: ROLE_BANNING });
      const picking = screen.getByRole('radio', { name: ROLE_PICKING });
      expect(banning).toHaveAttribute('aria-checked', 'true');
      expect(banning).not.toHaveAttribute('aria-disabled');
      expect(picking).not.toHaveAttribute('aria-disabled');
      expect(screen.queryByRole('radio', { name: 'Striking' })).toBeNull();
      expect(screen.getByTestId('set-state-assumption-line').textContent).toBe(
        'Assuming Game 2+ · Striking · no stages played yet, no bans',
      );
      await user.click(picking);
      expect(picking).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('set-state-assumption-line').textContent).toBe(
        'Assuming Game 2+ · Picking · no stages played yet, no bans',
      );
    });

    it('segmented-set-state: choosing Game 1 again resets the role to striking', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      await user.click(screen.getByRole('radio', { name: ROLE_PICKING }));
      expect(screen.getByTestId('set-state-assumption-line').textContent).toContain('Picking');
      await user.click(screen.getByRole('radio', { name: 'Game 1' }));
      expect(screen.getByTestId('set-state-assumption-line').textContent).toBe(ASSUMPTION_GAME1);
      expect(screen.getByRole('radio', { name: 'Striking' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('segmented-set-state: "stages played · bans" opens ONLY the prior-stages and bans checklists — no phase or role radio is left in the popover', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      await user.click(screen.getByRole('button', { name: PLAYED_BANS_LINK }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Stages played so far')).toBeInTheDocument();
      expect(within(dialog).getByText('Stages banned so far')).toBeInTheDocument();
      expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
      expect(within(dialog).queryByLabelText('Game 2+')).toBeNull();
      expect(within(dialog).queryByLabelText('Picking')).toBeNull();
      expect(within(dialog).getAllByRole('checkbox').length).toBeGreaterThan(0);
    });

    it('segmented-set-state: the popover link is described by the assumption line (aria-describedby)', () => {
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      const link = screen.getByRole('button', { name: PLAYED_BANS_LINK });
      const assumptionLine = screen.getByTestId('set-state-assumption-line');
      expect(assumptionLine.id).toBeTruthy();
      expect(link.getAttribute('aria-describedby')).toBe(assumptionLine.id);
    });

    it('segmented-set-state: no status colour and no bar colour outside blue series rows — neutral overlines, no emerald or destructive class', () => {
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
        ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5),
      ];
      const { container } = renderAdvisor(matches);
      // The rows and overlines carry no status colour (the toggle primitive's own
      // `aria-invalid:border-destructive` base class is not a data mark).
      for (const slot of ['counterpick-pick', 'counterpick-ban']) {
        const section = container.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
        expect(section, slot).not.toBeNull();
        expect(section.innerHTML).not.toMatch(/emerald|destructive/);
      }
      const pickHead = screen.getByText('Pick these');
      const banHead = screen.getByText('Ban / avoid these');
      expect(pickHead.className).toBe(banHead.className);
      expect(pickHead.className).toMatch(/uppercase/);
      expect(pickHead.className).toMatch(/text-muted-foreground/);
    });

    it('segmented-set-state: each Pick / Ban section is series rows against the pairing all-time reference, with one reference legend line', () => {
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
        ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5),
      ];
      const { container } = renderAdvisor(matches);
      const lists = container.querySelectorAll('[data-slot="comparison-bars-series"]');
      expect(lists).toHaveLength(2);
      // Pairing all-time rate: 12 wins of 20 games = 60%.
      expect(screen.getAllByText('60% all time')).toHaveLength(1);
      const ticks = container.querySelectorAll('[data-slot="comparison-bar-reference"]');
      expect(ticks).toHaveLength(4);
      expect((ticks[0] as HTMLElement).style.left).toBe('60%');
    });

    it('segmented-set-state: Pick / Ban rows are text-only like the sketch and the Stage breakdown (PD-46-3) — no stage thumbnail, the name truncates with a full-name tooltip', () => {
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
        ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5),
      ];
      const { container } = renderAdvisor(matches);
      const lists = container.querySelectorAll('[data-slot="comparison-bars-series"]');
      expect(lists).toHaveLength(2);
      for (const list of lists) {
        expect(list.querySelectorAll('img')).toHaveLength(0);
      }
      const labels = container.querySelectorAll('[data-slot="comparison-bar-label"]');
      expect(Array.from(labels).map((label) => label.textContent)).toEqual([
        'Battlefield',
        'Town and City',
        'Smashville',
        'Small Battlefield',
      ]);
      expect((labels[3] as HTMLElement).title).toBe('Small Battlefield');
    });

    it('a counterpick stage with a fully qualifying record is absent at game one and present from game two', async () => {
      const user = userEvent.setup();
      const matches = [
        ...matchesOnStage(LYLAT_CRUISE, 5, 0), // fully qualifying, illegal at game 1
        ...matchesOnStage(BATTLEFIELD, 5, 0),
      ];
      renderAdvisor(matches);

      expect(screen.queryByText(/Lylat Cruise/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));

      expect(await screen.findByText('Lylat Cruise')).toBeInTheDocument();
    });

    it('choosing Picking at Game 2+ changes the legal-stage set exactly as the old radio: a stage won earlier under the modified repeat rule leaves both groups', async () => {
      const user = userEvent.setup();
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
      ];
      renderAdvisor(matches);

      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      await user.click(screen.getByRole('radio', { name: ROLE_PICKING }));
      await user.click(screen.getByRole('button', { name: PLAYED_BANS_LINK }));

      const priorSection = screen.getByText('Stages played so far').closest('div')!;
      await user.click(within(priorSection).getByLabelText('Battlefield'));
      await user.click(within(priorSection).getByRole('radio', { name: 'Won' }));
      await user.keyboard('{Escape}'); // close the popover so its own checklist labels stop shadowing the bar labels

      expect(screen.queryByText('Battlefield')).not.toBeInTheDocument();
      expect(screen.getByText(/Town and City/)).toBeInTheDocument();
    });

    it('the same prior-stage win at Game 2+ while BANNING (role striking) leaves that stage in place — the DSR clause applies only to the picking role', async () => {
      const user = userEvent.setup();
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
      ];
      renderAdvisor(matches);

      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      await user.click(screen.getByRole('button', { name: PLAYED_BANS_LINK }));
      const priorSection = screen.getByText('Stages played so far').closest('div')!;
      await user.click(within(priorSection).getByLabelText('Battlefield'));
      await user.click(within(priorSection).getByRole('radio', { name: 'Won' }));
      await user.keyboard('{Escape}');

      expect(screen.getByText(/Battlefield/)).toBeInTheDocument();
    });

    it('banning every stage in the active ruleset renders the no-legal-stage message with zero bars and no abstention sentence', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));

      await user.click(screen.getByRole('button', { name: PLAYED_BANS_LINK }));
      const bansSection = screen.getByText('Stages banned so far').closest('div')!;
      const banCheckboxes = within(bansSection).getAllByRole('checkbox');
      for (const checkbox of banCheckboxes) {
        await user.click(checkbox);
      }

      expect(
        screen.getByText('No stage is legal under this ruleset and set state.'),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      expect(screen.queryByText(/Not enough data yet/)).not.toBeInTheDocument();
    });

    it('choosing a later game phase without any prior stage still produces a valid assumption line and does not block closing the control', async () => {
      const user = userEvent.setup();
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));

      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      expect(screen.getByTestId('set-state-assumption-line').textContent).toContain(
        'Assuming Game 2+ · Striking · no stages played yet, no bans',
      );

      await user.click(screen.getByRole('button', { name: PLAYED_BANS_LINK }));
      await user.keyboard('{Escape}');
      expect(screen.queryByText('Stages played so far')).not.toBeInTheDocument();
    });

    it('resets the set state to the default when the pairing changes', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/matchups']}>
            <MatchupsContext.Provider value={baseMatchupsContextValue()}>
              <CounterpickAdvisor matchupMatches={matchesOnStage(BATTLEFIELD, 5, 0)} />
            </MatchupsContext.Provider>
          </MemoryRouter>
        </TooltipProvider>,
      );

      await user.click(screen.getByRole('radio', { name: 'Game 2+' }));
      await user.click(screen.getByRole('radio', { name: ROLE_PICKING }));
      expect(screen.getByTestId('set-state-assumption-line').textContent).toContain(
        'Assuming Game 2+ · Picking',
      );

      const differentPairing = matchesOnStage(BATTLEFIELD, 5, 0).map((m) => ({
        ...m,
        opponent_id: 99,
      }));
      rerender(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/matchups']}>
            <MatchupsContext.Provider value={baseMatchupsContextValue()}>
              <CounterpickAdvisor matchupMatches={differentPairing} />
            </MatchupsContext.Provider>
          </MemoryRouter>
        </TooltipProvider>,
      );

      expect(screen.getByTestId('set-state-assumption-line').textContent).toBe(ASSUMPTION_GAME1);
      expect(screen.getByRole('radio', { name: 'Game 1' })).toHaveAttribute('aria-checked', 'true');
    });

    it('grep gate: the assumption sentence is never delivered through a hover surface — the only tooltip is the unavailable role reason, and only on hover', () => {
      // Mechanical statement mirrored from the plan's own acceptance grep;
      // asserted here too so a component-level regression is caught by the
      // default suite, not only by a shell command run by hand.
      renderAdvisor(matchesOnStage(BATTLEFIELD, 5, 0));
      expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeInTheDocument();
    });
  });

  describe('Phase 38-04: bar click writes the stage axis to the URL (D-07)', () => {
    it('clicking a Pick row calls setDrillDown with exactly that stage id, and scrolls to the results-table anchor', async () => {
      const scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      const user = userEvent.setup();

      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0), // best -> pick[0]
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ];
      renderAdvisor(matches);

      const pickSection = screen.getByText('Pick these').closest('div')!;
      const battlefieldRow = within(pickSection).getAllByRole('button')[0]!;
      await user.click(battlefieldRow);

      expect(setDrillDownMock).toHaveBeenCalledWith({ stageId: BATTLEFIELD.id });
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('clicking a Ban row does the same for that stage', async () => {
      const scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      const user = userEvent.setup();

      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
        ...matchesOnStage(SMASHVILLE, 3, 2),
        ...matchesOnStage(SMALL_BATTLEFIELD, 0, 5), // worst -> the single ban
      ];
      renderAdvisor(matches);

      const banSection = screen.getByText('Ban / avoid these').closest('div')!;
      const banRow = within(banSection).getAllByRole('button')[0]!;
      await user.click(banRow);

      expect(setDrillDownMock).toHaveBeenCalledWith({ stageId: SMALL_BATTLEFIELD.id });
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    it('clicking a different row writes that row’s own stage id, not the whole pairing', async () => {
      const user = userEvent.setup();
      const matches = [
        ...matchesOnStage(BATTLEFIELD, 5, 0),
        ...matchesOnStage(TOWN_AND_CITY, 4, 1),
      ];
      renderAdvisor(matches);

      const pickSection = screen.getByText('Pick these').closest('div')!;
      const rows = within(pickSection).getAllByRole('button');
      await user.click(rows[1]!); // Town and City

      expect(setDrillDownMock).toHaveBeenCalledWith({ stageId: TOWN_AND_CITY.id });
    });
  });
});
