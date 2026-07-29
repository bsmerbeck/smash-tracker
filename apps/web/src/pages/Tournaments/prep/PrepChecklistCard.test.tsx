import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PREP_CHECKLIST_ITEM_IDS, type PrepPresenceMap } from '@smash-tracker/shared';
import { PrepChecklistCard } from './PrepChecklistCard';

const mutateSpy = vi.fn();

vi.mock('@/hooks/usePrepBrief', () => ({
  useTogglePrepChecklistItem: () => ({
    mutate: mutateSpy,
    isPending: false,
    variables: undefined,
  }),
}));

beforeEach(() => {
  mutateSpy.mockReset();
});

describe('PrepChecklistCard', () => {
  it('renders exactly 7 rows, one per PREP_CHECKLIST_ITEM_IDS entry', () => {
    render(<PrepChecklistCard entryKey="entry-1" checklist={{}} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(PREP_CHECKLIST_ITEM_IDS.length);
    expect(PREP_CHECKLIST_ITEM_IDS).toHaveLength(7);
  });

  it('renders an empty checklist as all seven rows unchecked and a 0/7 complete hint', () => {
    render(<PrepChecklistCard entryKey="entry-1" checklist={{}} />);
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
    }
    expect(screen.getByText('0/7 complete')).toBeInTheDocument();
  });

  it('renders a row checked when its id is present in the checklist prop', () => {
    const checklist: PrepPresenceMap = { confirmRegistration: true };
    render(<PrepChecklistCard entryKey="entry-1" checklist={checklist} />);
    expect(
      screen.getByRole('checkbox', { name: 'Confirm your registration and check-in time' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Review the ruleset and stage list' }),
    ).not.toBeChecked();
  });

  it('shows "3/7 complete" when three ids are present', () => {
    const checklist: PrepPresenceMap = {
      confirmRegistration: true,
      reviewRuleset: true,
      chargeGear: true,
    };
    render(<PrepChecklistCard entryKey="entry-1" checklist={checklist} />);
    expect(screen.getByText('3/7 complete')).toBeInTheDocument();
  });

  it('calls the toggle mutation with checked: true when clicking an unchecked row', async () => {
    const user = userEvent.setup();
    render(<PrepChecklistCard entryKey="entry-1" checklist={{}} />);
    await user.click(
      screen.getByRole('checkbox', { name: 'Confirm your registration and check-in time' }),
    );
    expect(mutateSpy).toHaveBeenCalledWith({ itemId: 'confirmRegistration', checked: true });
  });

  it('calls the toggle mutation with checked: false when clicking a checked row', async () => {
    const user = userEvent.setup();
    const checklist: PrepPresenceMap = { confirmRegistration: true };
    render(<PrepChecklistCard entryKey="entry-1" checklist={checklist} />);
    await user.click(
      screen.getByRole('checkbox', { name: 'Confirm your registration and check-in time' }),
    );
    expect(mutateSpy).toHaveBeenCalledWith({ itemId: 'confirmRegistration', checked: false });
  });

  it('never renders a raw machine ID as visible text', () => {
    render(<PrepChecklistCard entryKey="entry-1" checklist={{}} />);
    for (const itemId of PREP_CHECKLIST_ITEM_IDS) {
      expect(screen.queryByText(itemId)).not.toBeInTheDocument();
    }
  });
});
