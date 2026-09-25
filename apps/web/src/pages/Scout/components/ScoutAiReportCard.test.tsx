import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { PrepReportJobStatusEntry, ScoutReportRecord } from '@smash-tracker/shared';
import {
  CLAIMS_ERA_RECORD,
  GAMEPLAN_CONNECTIVE,
  H2H_CLAIM,
  STAGE_CLAIM,
  USAGE_CLAIM,
} from '@/test/claimReportFixtures';
import { PrepPaidReportsCard } from '@/pages/Tournaments/prepPaid/PrepPaidReportsCard';
import { ScoutAiReportCard } from './ScoutAiReportCard';

// Isolated component render (no AuthProvider ancestor) — mirrors
// `DashboardPrepActionSlot.test.tsx`'s established pattern of mocking the
// profile-derived hook directly rather than wiring up the whole auth stack.
const useIsDemoAccount = vi.fn(() => false);
vi.mock('@/hooks/useIsDemoAccount', () => ({
  useIsDemoAccount: () => useIsDemoAccount(),
}));

// Plan 39-09: the paid prep card's collaborators, mocked ONLY so the
// inheritance case at the bottom can mount the REAL `PrepPaidReportsCard`
// around the REAL `ScoutAiReportCard` (mirrors `PrepPaidReportsCard.test.tsx`,
// minus its `ScoutAiReportCard` stub). None of these modules is imported by
// `ScoutAiReportCard` itself.
vi.mock('@/lib/canonicalEvents', () => ({ postCanonicalEvent: vi.fn() }));
vi.mock('@/hooks/useBilling', () => ({
  useCredits: () => ({ data: { freeAccess: true, balance: 0, packs: [] }, refetch: vi.fn() }),
}));
let prepJobs: Record<string, PrepReportJobStatusEntry> = {};
vi.mock('@/hooks/usePrepReportJobs', () => ({
  usePrepReportJobs: () => ({ jobsByOpponentName: prepJobs }),
}));
vi.mock('@/hooks/usePrepPaidReports', () => ({
  useGeneratePrepReport: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useStartPrepBundle: () => ({ mutate: vi.fn() }),
  executeBundleChildren: vi.fn(),
}));
vi.mock('@/pages/Tournaments/prepPaid/OpponentBindingConfirm', () => ({
  OpponentBindingConfirm: () => null,
}));
vi.mock('@/components/billing/BuyCreditsDialog', () => ({ BuyCreditsDialog: () => null }));
const reportsGetSpy = vi.fn();
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { reports: { get: (...args: unknown[]) => reportsGetSpy(...args) } },
}));

const RECORD: ScoutReportRecord = {
  id: 'r1',
  createdAt: Date.now() - 60 * 1000,
  model: 'claude-opus-4-8',
  player: { id: 1802316, gamerTag: 'Pandem1c', userSlug: 'user/07dc2239' },
  report: {
    overview: 'A fast-falling Fox/Falco player who plays aggressively.',
    gameplan: ['Punish landing lag hard.', 'Avoid neutral vs their dash dance.'],
    characterStrategy: {
      picks: ['Mario'],
      reasoning: 'Game 1: Mario; if they swap to Falco, keep Mario.',
    },
    stageStrategy: {
      bans: ['Final Destination'],
      picks: ['Battlefield'],
      reasoning: 'They perform best on flat stages with no platforms.',
    },
    headToHead: null,
    watchFor: ['Likes to shine spike off stage.'],
    confidenceNotes: 'Only 20 games sampled — treat character splits as light samples.',
  },
};

beforeEach(() => {
  useIsDemoAccount.mockReturnValue(false);
});

describe('ScoutAiReportCard', () => {
  it('renders the overview, gameplan, stage strategy, watch-for, and confidence notes', () => {
    render(<ScoutAiReportCard record={RECORD} />);

    expect(screen.getAllByText(RECORD.report.overview).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Punish landing lag hard.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avoid neutral vs their dash dance.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Final Destination').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Battlefield').length).toBeGreaterThan(0);
    expect(screen.getAllByText(RECORD.report.stageStrategy.reasoning).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Likes to shine spike off stage.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(RECORD.report.confidenceNotes).length).toBeGreaterThan(0);
  });

  it('renders the character strategy section when present', () => {
    render(<ScoutAiReportCard record={RECORD} />);

    expect(screen.getAllByText('Character strategy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mario').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Game 1: Mario; if they swap to Falco, keep Mario.').length,
    ).toBeGreaterThan(0);
  });

  it('does not render a character strategy section when absent (pre-B.1 stored record)', () => {
    const record: ScoutReportRecord = {
      ...RECORD,
      report: { ...RECORD.report, characterStrategy: undefined },
    };
    render(<ScoutAiReportCard record={record} />);
    expect(screen.queryByText('Character strategy')).not.toBeInTheDocument();
  });

  it('does not render a head-to-head section when headToHead is null', () => {
    render(<ScoutAiReportCard record={RECORD} />);
    expect(screen.queryByText('Head-to-head')).not.toBeInTheDocument();
  });

  it('renders the head-to-head section when present', () => {
    const record: ScoutReportRecord = {
      ...RECORD,
      report: {
        ...RECORD.report,
        headToHead: 'You are 2-1 against this player, all on Battlefield.',
      },
    };
    render(<ScoutAiReportCard record={record} />);
    expect(screen.getAllByText('Head-to-head').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('You are 2-1 against this player, all on Battlefield.').length,
    ).toBeGreaterThan(0);
  });

  it('shows a "Generated <relative date>" line', () => {
    render(<ScoutAiReportCard record={RECORD} />);
    expect(screen.getByText(/Generated .*ago/)).toBeInTheDocument();
  });
});

describe('ScoutAiReportCard — download', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    clickSpy.mockRestore();
  });

  it('downloads a Markdown blob named after the gamer tag and date on click', async () => {
    const user = userEvent.setup();
    render(<ScoutAiReportCard record={RECORD} />);

    await user.click(screen.getByRole('button', { name: /Download \(\.md\)/ }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blobArg] = createObjectURL.mock.calls[0] as [Blob];
    expect(blobArg.type).toContain('text/markdown');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

describe('ScoutAiReportCard — print', () => {
  it('calls window.print() when the print button is clicked', async () => {
    const user = userEvent.setup();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ScoutAiReportCard record={RECORD} />);

    await user.click(screen.getByRole('button', { name: /Print \/ Save as PDF/ }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});

// Phase 30.3 (Gate 6, owner/Codex hard gate): Download/Print are disabled
// for a demo/research account, and a positive control proves an ordinary
// account keeps both fully functional.
describe('ScoutAiReportCard — demo account gating', () => {
  it('disables Download and Print with an explanation for a demo account', () => {
    useIsDemoAccount.mockReturnValue(true);
    render(<ScoutAiReportCard record={RECORD} />);

    const downloadButton = screen.getByRole('button', { name: /Download \(\.md\)/ });
    const printButton = screen.getByRole('button', { name: /Print \/ Save as PDF/ });
    expect(downloadButton).toBeDisabled();
    expect(printButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute('title', 'Disabled for public-data research accounts.');
    expect(printButton).toHaveAttribute('title', 'Disabled for public-data research accounts.');
  });

  it('positive control: an ordinary account keeps Download and Print enabled', () => {
    useIsDemoAccount.mockReturnValue(false);
    render(<ScoutAiReportCard record={RECORD} />);

    expect(screen.getByRole('button', { name: /Download \(\.md\)/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Print \/ Save as PDF/ })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-09, RPT-06): claim-anchored sections, screen AND print.
// ---------------------------------------------------------------------------

function screenCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector<HTMLElement>('[data-slot="card"]');
  if (!card) throw new Error('screen card not rendered');
  return card;
}

function printBlock(container: HTMLElement): HTMLElement {
  const block = container.querySelector<HTMLElement>('.print-packet-root');
  if (!block) throw new Error('print block not rendered');
  return block;
}

function claimIdsIn(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll('[data-claim-id]')].map((node) =>
    node.getAttribute('data-claim-id'),
  );
}

describe('ScoutAiReportCard — claims-era record (plan 39-09)', () => {
  it('renders one claim line per surviving claim id, in the stored section order', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    // overview [h2h] · gameplan [stage, (abstained), usage] · watchFor [(abstained)]
    expect(claimIdsIn(screenCard(container))).toEqual([
      H2H_CLAIM.id,
      STAGE_CLAIM.id,
      USAGE_CLAIM.id,
    ]);
  });

  it("shows each claim's app-rendered figure, never the connective's numbers", () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const figures = [...screenCard(container).querySelectorAll('[data-claim-figure]')].map(
      (node) => node.textContent,
    );
    expect(figures).toEqual(['7–3 · 70%', '34–21 · 62%', '60% (12/20)']);
    for (const figure of figures) {
      expect(figure).not.toMatch(/9-1|90%/);
    }
  });

  it('a partially-abstained section renders only the surviving bullets and NOT the abstention sentence', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const gameplanHeading = within(screenCard(container)).getByRole('heading', {
      name: 'Game plan',
    });
    const gameplan = gameplanHeading.parentElement as HTMLElement;
    expect(gameplan.querySelectorAll('li')).toHaveLength(2);
    expect(within(gameplan).queryByText(/Not enough data yet/)).not.toBeInTheDocument();
  });

  it('an all-abstained section renders the abstention sentence and no bullets', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const watchForHeading = within(screenCard(container)).getByRole('heading', {
      name: 'Watch for',
    });
    const watchFor = watchForHeading.parentElement as HTMLElement;
    expect(within(watchFor).getByText('Not enough data yet — 2 more games needed.')).toBeVisible();
    expect(watchFor.querySelector('ul')).toBeNull();
    expect(watchFor.querySelectorAll('li')).toHaveLength(0);
  });

  it('a section whose stored connective is empty renders its bullets with no verdict prose and no empty paragraph (C1-H4)', () => {
    const record: ScoutReportRecord = {
      ...CLAIMS_ERA_RECORD,
      report: {
        ...CLAIMS_ERA_RECORD.report,
        gameplan: [],
        stageStrategy: { ...CLAIMS_ERA_RECORD.report.stageStrategy, reasoning: '' },
        sections: {
          ...CLAIMS_ERA_RECORD.report.sections,
          gameplan: { claimIds: [STAGE_CLAIM.id], connective: '' },
        },
      },
    };
    const { container } = render(<ScoutAiReportCard record={record} />);
    const gameplan = within(screenCard(container)).getByRole('heading', { name: 'Game plan' })
      .parentElement as HTMLElement;
    expect(gameplan.querySelectorAll('li')).toHaveLength(1);
    expect(within(gameplan).queryByText(GAMEPLAN_CONNECTIVE)).not.toBeInTheDocument();
    for (const paragraph of container.querySelectorAll('p')) {
      expect((paragraph.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('renders no confidence-notes line on screen when confidenceNotes is empty', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const muted = [...screenCard(container).querySelectorAll('p.text-xs')];
    expect(muted.every((node) => (node.textContent ?? '').trim().length > 0)).toBe(true);
    expect(container.querySelectorAll('p:empty')).toHaveLength(0);
  });

  it('the PRINT block carries the same claim figures as the screen (T-39-09-02)', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const print = printBlock(container);
    expect(claimIdsIn(print)).toEqual(claimIdsIn(screenCard(container)));
    expect(within(print).getByText('34–21 · 62%')).toBeInTheDocument();
    expect(
      within(print).getByText('Not enough data yet — 2 more games needed.'),
    ).toBeInTheDocument();
  });

  it("the PRINT block's own confidence-notes paragraph is guarded too (C2-H4): no heading, no empty paragraph", () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    const print = printBlock(container);
    expect(within(print).queryByText('Confidence notes')).not.toBeInTheDocument();
    expect(print.querySelectorAll('p:empty')).toHaveLength(0);
  });

  it('a legacy record (no claims/sections map) renders without throwing and keeps its free-prose bullets', () => {
    const { container } = render(<ScoutAiReportCard record={RECORD} />);
    expect(container.querySelectorAll('[data-claim-id]')).toHaveLength(0);
    expect(screen.getAllByText('Punish landing lag hard.').length).toBe(2);
    expect(screen.getAllByText('Confidence notes').length).toBe(1);
  });
});

describe('PrepPaidReportsCard inherits the claim rendering through its reuse of ScoutAiReportCard (plan 39-09)', () => {
  it('the expanded paid prep report shows the claim-anchored figures', async () => {
    const user = userEvent.setup();
    prepJobs = {
      Rival: {
        opponentName: 'Rival',
        jobId: 'job-1',
        status: 'succeeded',
        updatedAt: 1,
        resultRef: CLAIMS_ERA_RECORD.id,
      },
    };
    reportsGetSpy.mockResolvedValue(CLAIMS_ERA_RECORD);
    render(
      <MemoryRouter initialEntries={['/tournaments/entry-1/prep']}>
        <PrepPaidReportsCard
          entryKey="entry-1"
          likelyOpponents={{ Rival: true }}
          scoutBindings={{
            Rival: {
              provider: 'startgg',
              startggUserSlug: 'user/abc',
              displayTag: 'Rival',
              method: 'matchHistory',
              confirmedAt: 1,
            },
          }}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'View report' }));

    expect((await screen.findAllByText('34–21 · 62%')).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-claim-id]').length).toBeGreaterThan(0);
  });
});

describe('ScoutAiReportCard — legacy provenance line (plan 39-10, RPT-10)', () => {
  const EXPLAIN =
    "Generated before this app's report validator existed — its content wasn't machine-checked against your match data.";

  it('a legacy record (no claimSchemaVersion) shows the card-variant badge and its sentence under the Generated caption', () => {
    const { container } = render(<ScoutAiReportCard record={RECORD} />);
    const badge = container.querySelector('[data-legacy-report-badge="card"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent('Legacy');
    expect(screen.getByText(EXPLAIN)).toBeInTheDocument();
    // Directly under the "Generated" caption: the caption's next sibling holds the badge.
    const generated = screen.getByText(/^Generated (?!before)/);
    expect(generated.nextElementSibling?.contains(badge)).toBe(true);
  });

  it('a validated claims-era record shows neither the badge nor its sentence', () => {
    const { container } = render(<ScoutAiReportCard record={CLAIMS_ERA_RECORD} />);
    expect(container.querySelector('[data-legacy-report-badge]')).toBeNull();
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText(EXPLAIN)).not.toBeInTheDocument();
  });

  it('a half-written record (version present, validation block missing) is labelled legacy, never shown as validated', () => {
    const halfWritten: ScoutReportRecord = {
      ...CLAIMS_ERA_RECORD,
      report: { ...CLAIMS_ERA_RECORD.report, validation: undefined },
    };
    render(<ScoutAiReportCard record={halfWritten} />);
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.getByText(EXPLAIN)).toBeInTheDocument();
  });
});
