import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { render, screen, within } from '@testing-library/react';
import type { Match } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ResultsContextCard } from './ResultsContextCard';
import { ReviewModeStrip } from './ReviewModeStrip';

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'Rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function renderCard(props: { synced: Match[]; manual: Match[] }) {
  return render(
    <TooltipProvider>
      <ResultsContextCard {...props} />
    </TooltipProvider>,
  );
}

const INFERRED_TOOLTIP = 'Included from your curated opponent list — not synced from this event.';

describe('ResultsContextCard', () => {
  it('INV-8: every manual row renders the Manual outline badge with tooltip text and aria-label; synced rows render no badge', () => {
    const synced: Match[] = [
      makeMatch({ id: 'synced-1', time: 100, win: true, opponent: 'SyncedOpp1' }),
      makeMatch({ id: 'synced-2', time: 200, win: false, opponent: 'SyncedOpp2' }),
    ];
    const manual: Match[] = [
      makeMatch({ id: 'manual-1', time: 150, win: true, opponent: 'ManualOpp1' }),
      makeMatch({ id: 'manual-2', time: 250, win: false, opponent: 'ManualOpp2' }),
    ];
    renderCard({ synced, manual });

    // Presence: exactly one Manual badge (accessible via its aria-label,
    // which is also the tooltip's content) per manual row.
    const manualBadges = screen.getAllByLabelText(INFERRED_TOOLTIP);
    expect(manualBadges).toHaveLength(2);
    for (const badge of manualBadges) {
      expect(badge).toHaveTextContent('Manual');
    }

    // Absence: neither synced row's container carries a "Manual" badge.
    const syncedRow1 = screen.getByText('SyncedOpp1').closest<HTMLElement>('.rounded-md')!;
    const syncedRow2 = screen.getByText('SyncedOpp2').closest<HTMLElement>('.rounded-md')!;
    expect(within(syncedRow1).queryByText('Manual')).not.toBeInTheDocument();
    expect(within(syncedRow2).queryByText('Manual')).not.toBeInTheDocument();
    expect(within(syncedRow1).queryByLabelText(INFERRED_TOOLTIP)).not.toBeInTheDocument();
    expect(within(syncedRow2).queryByLabelText(INFERRED_TOOLTIP)).not.toBeInTheDocument();

    // Presence within each manual row's own container.
    const manualRow1 = screen.getByText('ManualOpp1').closest<HTMLElement>('.rounded-md')!;
    const manualRow2 = screen.getByText('ManualOpp2').closest<HTMLElement>('.rounded-md')!;
    expect(within(manualRow1).getByText('Manual')).toBeInTheDocument();
    expect(within(manualRow2).getByText('Manual')).toBeInTheDocument();
  });

  it('rows render opponent, fine-print date, and the house W/L treatment, chronologically ordered', () => {
    const synced: Match[] = [
      makeMatch({ id: 'sync-late', time: 3000, win: true, opponent: 'LateSynced' }),
    ];
    const manual: Match[] = [
      makeMatch({ id: 'man-early', time: 1000, win: false, opponent: 'EarlyManual' }),
      makeMatch({ id: 'man-mid', time: 2000, win: true, opponent: 'MidManual' }),
    ];
    renderCard({ synced, manual });

    expect(screen.getByText('EarlyManual')).toBeInTheDocument();
    expect(screen.getByText('MidManual')).toBeInTheDocument();
    expect(screen.getByText('LateSynced')).toBeInTheDocument();

    const expectedDate = new Date(1000).toLocaleDateString(i18n.language);
    expect(screen.getByText('EarlyManual').closest('.rounded-md')!.textContent).toContain(
      expectedDate,
    );

    // House W/L treatment reuses common.win/common.loss text.
    const winBadges = screen.getAllByText('Win');
    const lossBadges = screen.getAllByText('Loss');
    expect(winBadges).toHaveLength(2); // MidManual + LateSynced
    expect(lossBadges).toHaveLength(1); // EarlyManual

    // Chronological order: EarlyManual, MidManual, LateSynced.
    const opponentNames = screen
      .getAllByText(/^(EarlyManual|MidManual|LateSynced)$/)
      .map((el) => el.textContent);
    expect(opponentNames).toEqual(['EarlyManual', 'MidManual', 'LateSynced']);
  });

  it('empty state renders postEvent.results.empty.* with zero rows and zero placeholder content', () => {
    renderCard({ synced: [], manual: [] });

    expect(screen.getByText('No matches stored for this event yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Log the sets you played, or sync this event — your results will show up here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });
});

describe('ReviewModeStrip', () => {
  it('renders the secondary badge + muted sentence from postEvent.mode.*', () => {
    render(<ReviewModeStrip />);

    expect(screen.getByText('Post-event review')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This event is over — review how it went and annotate your matches while they're fresh.",
      ),
    ).toBeInTheDocument();
  });
});
