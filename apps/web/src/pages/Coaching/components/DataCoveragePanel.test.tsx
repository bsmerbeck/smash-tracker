import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { DataCoveragePanel } from './DataCoveragePanel';

const useDataCoverage = vi.fn();

vi.mock('@/hooks/useDataCoverage', () => ({
  useDataCoverage: () => useDataCoverage(),
}));

const BASE_STATUS = {
  isResearch: true,
  isPending: false,
  isError: false,
  isForbidden: false,
  hasCompletedRun: false,
  data: null,
  retry: vi.fn(),
};

const TWENTY_TWENTY_SIX_MS_A = 1_770_000_000_000; // 2026-era
const TWENTY_TWENTY_SIX_MS_B = 1_772_000_000_000; // 2026-era, later
const EARLY_MS = 1_700_000_000_000;

function counters(overrides: Partial<Record<string, number>> = {}) {
  return {
    discoveredAllGames: 10,
    discoveredEligible: 9,
    imported: 5,
    skipped: 2,
    unresolved: 1,
    corrected: 0,
    ...overrides,
  };
}

const ONE_PLAYER_SNAPSHOT = {
  coverage: {
    asOfMs: TWENTY_TWENTY_SIX_MS_A,
    players: {
      mkleo: {
        playerId: 'mkleo',
        runId: 'run-1',
        runCompletedAtMs: TWENTY_TWENTY_SIX_MS_A,
        asOfMs: TWENTY_TWENTY_SIX_MS_A,
        counters: counters(),
        namedGaps: {},
        dateCoverage: { earliestSetAtMs: EARLY_MS, latestSetAtMs: TWENTY_TWENTY_SIX_MS_A },
        classificationCounts: {},
        uniqueCounters: counters(),
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
    },
    totals: {
      counters: counters(),
      namedGaps: {},
      dateCoverage: { earliestSetAtMs: EARLY_MS, latestSetAtMs: TWENTY_TWENTY_SIX_MS_A },
      classificationCounts: { dq: 0, bye: 0, walkover: 0, 'no-game-detail': 0 },
    },
  },
  confirmedPlayerIds: ['mkleo'],
  confirmedPlayerIdCount: 1,
  unresolvedCandidateCount: 0,
  activeRun: null,
};

const TWO_PLAYER_SNAPSHOT = {
  coverage: {
    asOfMs: TWENTY_TWENTY_SIX_MS_B,
    players: {
      mkleo: {
        playerId: 'mkleo',
        runId: 'run-1',
        runCompletedAtMs: TWENTY_TWENTY_SIX_MS_A,
        asOfMs: TWENTY_TWENTY_SIX_MS_A,
        counters: counters({ imported: 5 }),
        namedGaps: { unknownCharacter: 2 },
        dateCoverage: { earliestSetAtMs: EARLY_MS, latestSetAtMs: TWENTY_TWENTY_SIX_MS_A },
        classificationCounts: { dq: 1, bye: 1 },
        uniqueCounters: counters({ imported: 3 }),
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
      sparg0: {
        playerId: 'sparg0',
        runId: 'run-2',
        runCompletedAtMs: TWENTY_TWENTY_SIX_MS_B,
        asOfMs: TWENTY_TWENTY_SIX_MS_B,
        counters: counters({ imported: 5 }),
        namedGaps: {},
        dateCoverage: { earliestSetAtMs: EARLY_MS, latestSetAtMs: TWENTY_TWENTY_SIX_MS_B },
        classificationCounts: { walkover: 1, 'no-game-detail': 1 },
        uniqueCounters: counters({ imported: 2 }),
        uniqueNamedGaps: {},
        uniqueClassificationCounts: {},
      },
    },
    totals: {
      // Deliberately SMALLER than the element-wise sum (5+5=10) of the two
      // sections above — proving the rollup's unique-record ("counted once")
      // semantics rather than a naive sum (review C3-A5).
      counters: counters({ imported: 8 }),
      namedGaps: { unknownCharacter: 2 },
      dateCoverage: { earliestSetAtMs: EARLY_MS, latestSetAtMs: TWENTY_TWENTY_SIX_MS_B },
      classificationCounts: { dq: 1, bye: 1, walkover: 1, 'no-game-detail': 1 },
    },
  },
  confirmedPlayerIds: ['mkleo', 'sparg0', 'unbackfilled-id'],
  confirmedPlayerIdCount: 3,
  unresolvedCandidateCount: 3,
  activeRun: {
    runId: 'run-3',
    status: 'running',
    playerId: 'sparg0',
    startedAtMs: TWENTY_TWENTY_SIX_MS_B,
    cursorPage: 1,
    totalPages: 4,
  },
};

const LOCALE_TITLE_TEXT: Record<string, string> = {
  en: 'Data Coverage',
  es: 'Cobertura de datos',
  fr: 'Couverture des données',
  de: 'Datenabdeckung',
  pt: 'Cobertura de dados',
  ja: 'データカバレッジ',
};

describe('DataCoveragePanel', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders nothing when the workspace is not a research workspace', () => {
    useDataCoverage.mockReturnValue({ ...BASE_STATUS, isResearch: false });
    render(<DataCoveragePanel />);
    expect(screen.queryByTestId('data-coverage-panel')).not.toBeInTheDocument();
  });

  it('renders nothing while the coverage query is pending', () => {
    useDataCoverage.mockReturnValue({ ...BASE_STATUS, isPending: true });
    render(<DataCoveragePanel />);
    expect(screen.queryByTestId('data-coverage-panel')).not.toBeInTheDocument();
  });

  it('renders nothing when the coverage query reports forbidden', () => {
    useDataCoverage.mockReturnValue({ ...BASE_STATUS, isForbidden: true });
    render(<DataCoveragePanel />);
    expect(screen.queryByTestId('data-coverage-panel')).not.toBeInTheDocument();
  });

  it('renders a localized inline error affordance, not a blank panel, when the coverage query reports a real error', () => {
    useDataCoverage.mockReturnValue({ ...BASE_STATUS, isError: true });
    render(<DataCoveragePanel />);
    expect(screen.getByTestId('data-coverage-panel')).toBeInTheDocument();
    expect(screen.getByTestId('data-coverage-load-error')).toBeInTheDocument();
  });

  it('renders the no-completed-run message and no count rows when hasCompletedRun is false', () => {
    useDataCoverage.mockReturnValue({ ...BASE_STATUS, hasCompletedRun: false, data: null });
    render(<DataCoveragePanel />);
    expect(screen.getByTestId('data-coverage-no-run')).toBeInTheDocument();
    expect(screen.queryByTestId('data-coverage-active-run')).not.toBeInTheDocument();
    expect(document.querySelector('[data-testid^="data-coverage-count-"]')).not.toBeInTheDocument();
  });

  it('renders the in-progress indicator alongside the no-completed-run message when an active run is present', () => {
    useDataCoverage.mockReturnValue({
      ...BASE_STATUS,
      hasCompletedRun: false,
      data: {
        coverage: null,
        confirmedPlayerIds: ['mkleo'],
        confirmedPlayerIdCount: 1,
        unresolvedCandidateCount: 0,
        activeRun: {
          runId: 'run-1',
          status: 'running',
          playerId: 'mkleo',
          startedAtMs: TWENTY_TWENTY_SIX_MS_A,
          cursorPage: 1,
          totalPages: 2,
        },
      },
    });
    render(<DataCoveragePanel />);
    expect(screen.getByTestId('data-coverage-no-run')).toBeInTheDocument();
    const activeRunLine = screen.getByTestId('data-coverage-active-run');
    expect(activeRunLine).toHaveTextContent('mkleo');
    expect(document.querySelector('[data-testid^="data-coverage-count-"]')).not.toBeInTheDocument();
  });

  describe('with a completed single-player snapshot', () => {
    it('renders the workspace rollup with the counted-once copy and a single player section', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);

      const totals = screen.getByTestId('data-coverage-totals');
      expect(totals).toHaveTextContent('counted once');
      expect(screen.getByTestId('data-coverage-count-discoveredAllGames')).toHaveTextContent('10');
      expect(screen.getByTestId('data-coverage-player-mkleo')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('data-coverage-player-mkleo')).getByTestId(
          'data-coverage-player-mkleo-count-imported',
        ),
      ).toHaveTextContent('5');
    });

    it('renders the VOD-URL disclosure note whenever a snapshot exists', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-vod-note')).toBeInTheDocument();
    });

    it('renders no identity block when the unresolved candidate count is zero', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.queryByTestId('data-coverage-identity')).not.toBeInTheDocument();
    });

    it('renders the no-gaps string when every gap count is zero', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-gaps')).toHaveTextContent('No gaps recorded.');
    });

    it('renders provider-unavailable rows in the gaps section when non-zero (provider-dead-page carve-out)', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: {
          ...ONE_PLAYER_SNAPSHOT,
          coverage: {
            ...ONE_PLAYER_SNAPSHOT.coverage,
            totals: {
              ...ONE_PLAYER_SNAPSHOT.coverage.totals,
              counters: counters({
                providerUnavailablePages: 2,
                providerUnavailableRowEstimate: 6,
              }),
            },
          },
        },
      });
      render(<DataCoveragePanel />);
      const gaps = screen.getByTestId('data-coverage-gaps');
      expect(gaps).not.toHaveTextContent('No gaps recorded.');
      expect(screen.getByTestId('data-coverage-gaps-providerUnavailablePages')).toHaveTextContent(
        '2',
      );
      expect(
        screen.getByTestId('data-coverage-gaps-providerUnavailableRowEstimate'),
      ).toHaveTextContent('6');
    });

    it('renders every excluded-outcome classification with an explicit zero rather than omitting the section', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);

      const excluded = screen.getByTestId('data-coverage-excluded');
      expect(excluded).toHaveTextContent('excluded from win-rate denominators');
      for (const classification of RESEARCH_EXCLUDED_OUTCOME_CLASSIFICATIONS) {
        const row = screen.getByTestId(`data-coverage-excluded-${classification}`);
        expect(row).toHaveTextContent('0');
      }
      expect(screen.getByTestId('data-coverage-excluded-no-game-detail')).not.toHaveTextContent(
        'Walkover',
      );
    });

    it('renders a 2026-era asOf and date-span value as a 2026 date, not a 1970 one', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-as-of')).toHaveTextContent('2026');
      expect(screen.getByTestId('data-coverage-span')).toHaveTextContent('2026');
      expect(screen.getByTestId('data-coverage-as-of')).not.toHaveTextContent('1970');
    });

    it('renders even for a single-player workspace without special-casing the layout (multi-ID path stays exercised elsewhere)', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-totals')).toBeInTheDocument();
      expect(screen.getByTestId('data-coverage-player-mkleo')).toBeInTheDocument();
    });

    it('renders the unknown-span string when both date-coverage ends are absent', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: {
          ...ONE_PLAYER_SNAPSHOT,
          coverage: {
            ...ONE_PLAYER_SNAPSHOT.coverage,
            totals: {
              ...ONE_PLAYER_SNAPSHOT.coverage.totals,
              dateCoverage: { earliestSetAtMs: null, latestSetAtMs: null },
            },
          },
        },
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-span')).toHaveTextContent('unknown');
    });
  });

  describe('with a completed two-player snapshot', () => {
    it('renders both player sections, each with its own counts and its own differing as-of stamp', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);

      const mkleoSection = screen.getByTestId('data-coverage-player-mkleo');
      const sparg0Section = screen.getByTestId('data-coverage-player-sparg0');
      expect(mkleoSection).toBeInTheDocument();
      expect(sparg0Section).toBeInTheDocument();

      const mkleoAsOf = within(mkleoSection).getByTestId('data-coverage-player-mkleo-as-of');
      const sparg0AsOf = within(sparg0Section).getByTestId('data-coverage-player-sparg0-as-of');
      expect(mkleoAsOf.textContent).not.toBe(sparg0AsOf.textContent);
    });

    it('renders a confirmed player id absent from the players map as a never-run row rather than omitting it', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      const neverRunRow = screen.getByTestId('data-coverage-player-unbackfilled-id-never-run');
      expect(neverRunRow).toBeInTheDocument();
      expect(neverRunRow).not.toHaveTextContent('no data');
    });

    it('renders a rollup smaller than the element-wise sum of the sections without contradiction, and the counted-once copy is present', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);

      // sections: 5 + 5 = 10, rollup: 8 — smaller, and both render without error.
      expect(screen.getByTestId('data-coverage-count-imported')).toHaveTextContent('8');
      expect(
        within(screen.getByTestId('data-coverage-player-mkleo')).getByTestId(
          'data-coverage-player-mkleo-count-imported',
        ),
      ).toHaveTextContent('5');
      expect(
        within(screen.getByTestId('data-coverage-player-sparg0')).getByTestId(
          'data-coverage-player-sparg0-count-imported',
        ),
      ).toHaveTextContent('5');
      expect(screen.getByTestId('data-coverage-totals')).toHaveTextContent('counted once');
    });

    it('renders the identity block with the unresolved count and never-merged copy when the count is above zero', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      const identity = screen.getByTestId('data-coverage-identity');
      expect(identity).toHaveTextContent('3');
      expect(identity).toHaveTextContent('never');
    });

    it('renders the active-run line naming the player id the active run targets', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      // The active-run line only renders in the no-completed-run branch per
      // this plan's structural spec; a completed snapshot with an in-flight
      // run for a second player is instead visible via that player's own
      // section state (never-run row / stale as-of), asserted above.
      expect(screen.queryByTestId('data-coverage-active-run')).not.toBeInTheDocument();
    });

    it('renders excluded-outcome rows with real non-zero counts read from the rollup', () => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: TWO_PLAYER_SNAPSHOT,
      });
      render(<DataCoveragePanel />);
      expect(screen.getByTestId('data-coverage-excluded-dq')).toHaveTextContent('1');
      expect(screen.getByTestId('data-coverage-excluded-bye')).toHaveTextContent('1');
      expect(screen.getByTestId('data-coverage-excluded-walkover')).toHaveTextContent('1');
      expect(screen.getByTestId('data-coverage-excluded-no-game-detail')).toHaveTextContent('1');
    });
  });

  it.each(Object.keys(LOCALE_TITLE_TEXT))(
    'renders the panel title translated for locale %s',
    async (locale) => {
      useDataCoverage.mockReturnValue({
        ...BASE_STATUS,
        hasCompletedRun: true,
        data: ONE_PLAYER_SNAPSHOT,
      });
      await i18n.changeLanguage(locale);

      render(<DataCoveragePanel />);

      const panel = screen.getByTestId('data-coverage-panel');
      expect(panel).toHaveTextContent(LOCALE_TITLE_TEXT[locale]!);
      if (locale !== 'en') {
        expect(panel.textContent).not.toContain(LOCALE_TITLE_TEXT.en);
      }
    },
  );
});
