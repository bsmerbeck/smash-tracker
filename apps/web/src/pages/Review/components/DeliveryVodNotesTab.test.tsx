import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IncludedVod } from '@smash-tracker/shared';
import { DeliveryVodNotesTab } from './DeliveryVodNotesTab';

// A trivial stand-in mirroring `ReviewDeliveryPage.test.tsx`'s own VodPlayer
// mock — this component's own seek-vs-switch logic is what's under test
// here, not the real YouTube/Twitch embed.
const seekMock = vi.fn();
vi.mock('@/pages/VodManager/components/VodPlayer', () => ({
  VodPlayer: ({
    vodUrl,
    startSeconds,
    onReady,
    seekRef,
  }: {
    vodUrl: string;
    startSeconds?: number;
    onReady?: () => void;
    seekRef?: { current: ((seconds: number) => void) | null };
  }) => {
    if (seekRef) {
      seekRef.current = (seconds: number) => seekMock(vodUrl, seconds);
    }
    return (
      <div data-testid="vod-player" data-vod-url={vodUrl} data-start-seconds={startSeconds ?? ''}>
        <button type="button" onClick={onReady}>
          mock-ready
        </button>
      </div>
    );
  },
}));

function makeVod(overrides: Partial<IncludedVod> = {}): IncludedVod {
  return {
    matchId: 'm1',
    label: 'Kazuya vs Sora',
    vodUrl: 'https://youtu.be/aaa111',
    timestamps: [
      { seconds: 42, note: 'missed ledgetrap' },
      { seconds: 90, note: 'roll habit' },
    ],
    ...overrides,
  } as IncludedVod;
}

describe('DeliveryVodNotesTab', () => {
  beforeEach(() => {
    seekMock.mockClear();
  });

  it('renders one player and a row per timestamp for a single included VOD', () => {
    render(<DeliveryVodNotesTab vods={[makeVod()]} />);

    expect(screen.getByTestId('vod-player')).toHaveAttribute(
      'data-vod-url',
      'https://youtu.be/aaa111',
    );
    expect(screen.getByText('Kazuya vs Sora')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /missed ledgetrap/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /roll habit/ })).toBeInTheDocument();
    // No switcher for a single VOD.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('renders a switcher for 2+ VODs; selecting a different VOD re-keys the player and shows its own notes', async () => {
    const user = userEvent.setup();
    const vods = [
      makeVod(),
      makeVod({
        matchId: 'm2',
        label: 'Fox vs Falco',
        vodUrl: 'https://youtu.be/bbb222',
        timestamps: [{ seconds: 15, note: 'edgeguard' }],
      }),
    ];
    render(<DeliveryVodNotesTab vods={vods} />);

    expect(screen.getByTestId('vod-player')).toHaveAttribute(
      'data-vod-url',
      'https://youtu.be/aaa111',
    );
    expect(screen.getByRole('button', { name: /missed ledgetrap/ })).toBeInTheDocument();

    const switcher = screen.getByRole('combobox');
    await user.click(switcher);
    await user.click(await screen.findByText('Fox vs Falco'));

    await waitFor(() =>
      expect(screen.getByTestId('vod-player')).toHaveAttribute(
        'data-vod-url',
        'https://youtu.be/bbb222',
      ),
    );
    expect(screen.getByRole('button', { name: /edgeguard/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /missed ledgetrap/ })).not.toBeInTheDocument();
  });

  it("clicking a timestamp row seeks the current player to that note's seconds", async () => {
    const user = userEvent.setup();
    render(<DeliveryVodNotesTab vods={[makeVod()]} />);

    await user.click(screen.getByRole('button', { name: /missed ledgetrap/ }));

    expect(seekMock).toHaveBeenCalledWith('https://youtu.be/aaa111', 42);
    // Same VOD — no reconstruction.
    expect(screen.getByTestId('vod-player')).toHaveAttribute(
      'data-vod-url',
      'https://youtu.be/aaa111',
    );
  });

  it('renders an empty-notes state for an included VOD with no timestamps (no crash)', () => {
    render(<DeliveryVodNotesTab vods={[makeVod({ timestamps: undefined })]} />);

    expect(screen.getByTestId('vod-player')).toBeInTheDocument();
    expect(screen.getByText('No timestamped notes for this VOD.')).toBeInTheDocument();
  });

  it('renders an empty-state message and no player for zero VODs', () => {
    render(<DeliveryVodNotesTab vods={[]} />);

    expect(screen.getByText('No footage was included with this delivery.')).toBeInTheDocument();
    expect(screen.queryByTestId('vod-player')).not.toBeInTheDocument();
  });
});
