import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match } from '@smash-tracker/shared';
import { VodNotesDialog } from './VodNotesDialog';

const updateMatch = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: {
      update: (...args: unknown[]) => updateMatch(...args),
    },
  },
}));

function baseMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'match-1',
    fighter_id: 1,
    opponent_id: 8,
    time: 1700000000000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: 'close game',
    matchType: 'offline-tourney',
    win: true,
    ...overrides,
  };
}

function renderDialog(match: Match, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <VodNotesDialog match={match} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('VodNotesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefills the VOD URL and existing timestamps', () => {
    renderDialog(
      baseMatch({
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    );

    expect(screen.getByLabelText('VOD URL')).toHaveValue('https://youtube.com/watch?v=abc123');
    expect(screen.getByText('2:41')).toBeInTheDocument();
    expect(screen.getByText('missed punish on shield')).toBeInTheDocument();
  });

  it('shows an empty state when there are no timestamps yet', () => {
    renderDialog(baseMatch());
    expect(screen.getByText('No timestamp notes yet.')).toBeInTheDocument();
  });

  it('adds a new timestamp parsed from m:ss input, sorted by seconds', async () => {
    const user = userEvent.setup();
    renderDialog(baseMatch({ vodTimestamps: [{ seconds: 490, note: 'lost ledge trump war' }] }));

    await user.type(screen.getByLabelText('Timestamp time'), '2:41');
    await user.type(screen.getByLabelText('Timestamp note'), 'missed punish on shield');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('2:41')).toBeInTheDocument();
    expect(within(items[1]!).getByText('8:10')).toBeInTheDocument();
  });

  it('rejects an unparseable time input', async () => {
    const user = userEvent.setup();
    renderDialog(baseMatch());

    await user.type(screen.getByLabelText('Timestamp time'), 'nope');
    await user.type(screen.getByLabelText('Timestamp note'), 'a note');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(screen.getByText('Enter a time as m:ss or h:mm:ss')).toBeInTheDocument();
    expect(screen.getByText('No timestamp notes yet.')).toBeInTheDocument();
  });

  it('rejects an empty note', async () => {
    const user = userEvent.setup();
    renderDialog(baseMatch());

    await user.type(screen.getByLabelText('Timestamp time'), '1:00');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    expect(screen.getByText('Enter a note for this timestamp')).toBeInTheDocument();
  });

  it('deletes an existing timestamp', async () => {
    const user = userEvent.setup();
    renderDialog(baseMatch({ vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }] }));

    await user.click(screen.getByRole('button', { name: 'Delete timestamp 2:41' }));
    expect(screen.getByText('No timestamp notes yet.')).toBeInTheDocument();
  });

  it('renders each timestamp as a deep link when a VOD URL is set', () => {
    renderDialog(
      baseMatch({
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
      }),
    );

    const link = screen.getByRole('link', { name: '2:41' });
    expect(link).toHaveAttribute('href', 'https://youtube.com/watch?v=abc123&t=161s');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('saves vodUrl and vodTimestamps via the matches update API, carrying other fields through unchanged', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const match = baseMatch({ stocksLeft: 2, eventName: 'Ultimate Singles' });
    renderDialog(match);

    await user.type(screen.getByLabelText('VOD URL'), 'https://youtube.com/watch?v=abc123');
    await user.type(screen.getByLabelText('Timestamp time'), '2:41');
    await user.type(screen.getByLabelText('Timestamp note'), 'missed punish on shield');
    await user.click(screen.getByRole('button', { name: 'Add timestamp' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith('match-1', {
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'rival',
      notes: 'close game',
      matchType: 'offline-tourney',
      win: true,
      stocksLeft: 2,
      eventName: 'Ultimate Singles',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });
  });

  it('clears vodUrl and vodTimestamps when the URL is emptied and all timestamps removed', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const match = baseMatch({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodTimestamps: [{ seconds: 161, note: 'missed punish on shield' }],
    });
    renderDialog(match);

    await user.click(screen.getByRole('button', { name: 'Delete timestamp 2:41' }));
    await user.clear(screen.getByLabelText('VOD URL'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const payload = updateMatch.mock.calls[0]![1];
    expect(payload).not.toHaveProperty('vodUrl');
    expect(payload).not.toHaveProperty('vodTimestamps');
  });

  it('closes the dialog after a successful save', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const { onOpenChange } = renderDialog(baseMatch());

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
