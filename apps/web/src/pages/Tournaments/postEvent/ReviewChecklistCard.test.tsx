import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REVIEW_CHECKLIST_ITEM_IDS, type PrepPresenceMap } from '@smash-tracker/shared';
import { ReviewChecklistCard } from './ReviewChecklistCard';

const mutateSpy = vi.fn();

vi.mock('@/hooks/usePrepBrief', () => ({
  useToggleReviewChecklistItem: () => ({
    mutate: mutateSpy,
    isPending: false,
    variables: undefined,
  }),
}));

beforeEach(() => {
  mutateSpy.mockReset();
});

describe('ReviewChecklistCard', () => {
  it('renders all five REVIEW_CHECKLIST_ITEM_IDS from the tuple with postEvent.checklist.items.* labels, never iterating the stored map', () => {
    expect(REVIEW_CHECKLIST_ITEM_IDS).toHaveLength(5);

    // A stored map carrying a stale/unknown key must render nothing extra —
    // proof the card iterates the fixed tuple, never the stored map.
    const reviewChecklist: PrepPresenceMap = { staleUnknownKey: true };
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={reviewChecklist} />);

    expect(screen.getAllByRole('checkbox')).toHaveLength(REVIEW_CHECKLIST_ITEM_IDS.length);
    expect(
      screen.getByRole('checkbox', {
        name: 'Attach VODs to your matches from this event',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Add timestamps to your event VODs' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Tag the turning-point moments' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Rewatch your losses and note what happened' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: 'Update your notes on the opponents you played',
      }),
    ).toBeInTheDocument();
  });

  it('progress counter renders {{checked}}/{{total}} complete from the presence map', () => {
    const reviewChecklist: PrepPresenceMap = { attachVods: true, addTimestamps: true };
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={reviewChecklist} />);

    expect(screen.getByText('2/5 complete')).toBeInTheDocument();
  });

  it('renders 0/5 complete for an empty presence map, all rows unchecked', () => {
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={{}} />);

    expect(screen.getByText('0/5 complete')).toBeInTheDocument();
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
    }
  });

  it('toggling an item calls the toggle mutation with {itemId, checked} — the {checked} body the PUT /review-checklist/:itemId route expects', async () => {
    const user = userEvent.setup();
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={{}} />);

    await user.click(
      screen.getByRole('checkbox', { name: 'Attach VODs to your matches from this event' }),
    );
    expect(mutateSpy).toHaveBeenCalledWith({ itemId: 'attachVods', checked: true });
  });

  it('toggling a checked item calls the mutation with checked: false', async () => {
    const user = userEvent.setup();
    const reviewChecklist: PrepPresenceMap = { attachVods: true };
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={reviewChecklist} />);

    await user.click(
      screen.getByRole('checkbox', { name: 'Attach VODs to your matches from this event' }),
    );
    expect(mutateSpy).toHaveBeenCalledWith({ itemId: 'attachVods', checked: false });
  });

  it('DOM ids are post-event-namespaced so both checklists can mount on one page without collision', () => {
    render(<ReviewChecklistCard entryKey="entry-42" reviewChecklist={{}} />);

    const checkbox = screen.getByRole('checkbox', {
      name: 'Attach VODs to your matches from this event',
    });
    expect(checkbox).toHaveAttribute('id', 'post-event-checklist-entry-42-attachVods');
    // Never the prep checklist's own namespace.
    expect(checkbox.id).not.toMatch(/^prep-checklist-/);
  });

  it('no celebration UI at 5/5 — the counter is the confirmation', () => {
    const reviewChecklist: PrepPresenceMap = Object.fromEntries(
      REVIEW_CHECKLIST_ITEM_IDS.map((itemId) => [itemId, true]),
    );
    render(<ReviewChecklistCard entryKey="entry-1" reviewChecklist={reviewChecklist} />);

    expect(screen.getByText('5/5 complete')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText(/complete!|congrat|nice work|great job/i)).not.toBeInTheDocument();
  });
});
