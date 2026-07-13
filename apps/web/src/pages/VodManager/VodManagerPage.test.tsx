import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { VodManagerPage } from './VodManagerPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';
import type { YouTubePlayerConfig, YouTubePlayerInstance } from '@/lib/useVodPlayer';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const getFighters = vi.fn();
const listMatches = vi.fn();
const listOpponents = vi.fn();
const updateMatch = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 0, name: 'no selection' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  };
}

function renderVodManager(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <Routes>
              <Route path="/vod" element={<VodManagerPage />} />
            </Routes>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type YTGlobal = NonNullable<Window['YT']>;

/** Removes any injected vendor scripts/globals so the useVodPlayer module-level singleton loaders start clean for every test. */
function resetVendorGlobals() {
  document.head.querySelectorAll('script').forEach((el) => el.remove());
  delete (window as { YT?: unknown }).YT;
  delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
}

describe('VodManagerPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    window.localStorage.clear();
    resetVendorGlobals();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    listOpponents.mockResolvedValue(['rival-one', 'rival-two']);
    updateMatch.mockResolvedValue({});
  });

  afterEach(() => {
    resetVendorGlobals();
  });

  it('applies the deep-linked match t= offset as the player initial start time', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(30);
  });

  it('repositions the live player instead of remounting when switching between matches sharing one video identity', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=90s',
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, destroy: vi.fn(), getCurrentTime: vi.fn(() => 754) };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(30);

    // Un-gate seek() (a no-op until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Select match vs rival-two' }));

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());

    // Same underlying video (abc123) as m1 — must NOT remount the player.
    expect(Player).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(90, true));
    expect(playVideo).toHaveBeenCalled();
  });

  it('prefers a match-level vodStartSeconds over the vodUrl t= param as the player initial start time', async () => {
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
        vodStartSeconds: 300,
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    expect(capturedConfig?.playerVars?.start).toBe(300);
  });

  it('repositions to the new match vodStartSeconds (over its t= param) when switching between matches sharing one video identity', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        time: 1_700_000_000_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=30s',
      }),
      makeMatch({
        id: 'm2',
        opponent: 'rival-two',
        time: 1_700_000_100_000,
        vodUrl: 'https://youtube.com/watch?v=abc123&t=90s',
        vodStartSeconds: 500,
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, destroy: vi.fn(), getCurrentTime: vi.fn(() => 754) };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // Un-gate seek() (a no-op until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Select match vs rival-two' }));

    await waitFor(() => expect(screen.getByText('vs. rival-two')).toBeInTheDocument());

    // Same underlying video (abc123) as m1 — must NOT remount the player.
    expect(Player).toHaveBeenCalledTimes(1);
    // m2's vodStartSeconds (500) wins over its t=90s param.
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(500, true));
    expect(playVideo).toHaveBeenCalled();
  });

  it('adds a timestamp note via the inline composer, prefilled from the live position, sorted ascending, carrying through other match fields', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [{ seconds: 900, note: 'existing note' }],
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    const getCurrentTime = vi.fn(() => 754);
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, destroy: vi.fn(), getCurrentTime };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');

    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));

    // Un-gate getCurrentTime()/seek() (both no-ops until the live player reports ready).
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) A composer time input and note input render below the player.
    const timeInput = screen.getByLabelText('Timestamp time');
    const noteInput = screen.getByLabelText('Timestamp note');

    // (2) Focusing the time input prefills it from getCurrentTime() (754s -> 12:34).
    await user.click(timeInput);
    expect(timeInput).toHaveValue('12:34');

    // (3) Enter on the note input saves — single carry-through PATCH.
    await user.type(noteInput, 'new note{Enter}');

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    // Other match fields survive the PATCH untouched.
    expect(input.win).toBe(true);
    expect(input.fighter_id).toBe(mario.id);
    expect(input.gsp).toBe(1_234_567);
    // (4) Ascending sort: the new 754s note lands BEFORE the existing 900s note.
    expect(input.vodTimestamps).toEqual([
      { seconds: 754, note: 'new note' },
      { seconds: 900, note: 'existing note' },
    ]);

    // Adding a note must never pause/interrupt playback.
    expect(playVideo).not.toHaveBeenCalled();
  });

  it('edits a timestamp note in place (no dialog), re-sorting ascending, via a single full-carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) Clicking pencil on note B's row swaps it into inline time+text inputs prefilled from the row's current values.
    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    const timeInput = screen.getByLabelText('Edit timestamp time');
    const noteInput = screen.getByLabelText('Edit timestamp note');
    expect(timeInput).toHaveValue('1:30');
    expect(noteInput).toHaveValue('note B');

    // (2) Editing the time to sort before note A, then Enter commits.
    await user.clear(timeInput);
    await user.type(timeInput, '0:10{Enter}');

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    // Every other match field is carried through unchanged.
    expect(input.win).toBe(true);
    expect(input.fighter_id).toBe(mario.id);
    expect(input.gsp).toBe(1_234_567);
    // The edited entry (now 10s) re-sorts ahead of note A (30s).
    expect(input.vodTimestamps).toEqual([
      { seconds: 10, note: 'note B' },
      { seconds: 30, note: 'note A' },
    ]);
  });

  it('discards an in-place edit on Escape without mutating', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    const timeInput = screen.getByLabelText('Edit timestamp time');
    await user.clear(timeInput);
    await user.type(timeInput, '5:00');
    await user.type(timeInput, '{Escape}');

    expect(updateMatch).not.toHaveBeenCalled();
    // Edit mode closed with no value change — the pencil affordance and
    // original note text are back, the edit inputs are gone.
    expect(screen.queryByLabelText('Edit timestamp time')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit timestamp 1:30')).toBeInTheDocument();
    expect(screen.getByText('note B')).toBeInTheDocument();
  });

  it('removes a note via an AlertDialog confirm (not an immediate delete), via a single full-carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) Clicking trash opens a confirm — no immediate delete.
    await user.click(screen.getByLabelText('Delete timestamp 1:30'));
    const alert = await screen.findByRole('alertdialog');
    expect(within(alert).getByText('Delete this timestamp note?')).toBeInTheDocument();

    // (2) Canceling closes the dialog with no mutation.
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(updateMatch).not.toHaveBeenCalled();
    expect(screen.getByText('note B')).toBeInTheDocument();

    // (3) Confirming removes the note via the same full-carry-through PATCH.
    await user.click(screen.getByLabelText('Delete timestamp 1:30'));
    const alert2 = await screen.findByRole('alertdialog');
    await user.click(within(alert2).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([{ seconds: 30, note: 'note A' }]);
  });

  it('renders note tag chips and adds a preset tag via the note combobox, carrying other notes and match fields through without seeking', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        vodTimestamps: [
          { seconds: 30, note: 'note A', tags: ['punish'] },
          { seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo: vi.fn(), destroy: vi.fn(), getCurrentTime: vi.fn(() => 754) };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) note A's existing preset tag renders as a chip with its translated
    // label (scoped to note A's row — the tag filter row in VodMatchList
    // also renders "Punish" as a toggle chip, so a plain text query would
    // be ambiguous).
    const noteARow = screen.getByText('note A').closest('li')!;
    expect(within(noteARow).getByText('Punish')).toBeInTheDocument();

    // (2) Opening note A's add-combobox (scoped to its row) and picking
    // another preset PATCHes both tags onto note A, carrying note B and
    // other match fields through unchanged — and never seeks/selects.
    await user.click(within(noteARow).getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Edgeguard' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([
      { seconds: 30, note: 'note A', tags: ['punish', 'edgeguard'] },
      { seconds: 90, note: 'note B' },
    ]);
    expect(input.gsp).toBe(1_234_567);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('removes a note tag via the chip X, omitting tags from that note only, without disturbing other notes', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A', tags: ['punish'] },
          { seconds: 90, note: 'note B', tags: ['mistake'] },
        ],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(await screen.findByRole('button', { name: 'Remove tag Punish' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.vodTimestamps).toEqual([
      { seconds: 30, note: 'note A' },
      { seconds: 90, note: 'note B', tags: ['mistake'] },
    ]);
  });

  it('seeks the live player and highlights the clicked row body; edit/delete on another row do not change the selection (D-13/D-14)', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [
          { seconds: 30, note: 'note A' },
          { seconds: 90, note: 'note B' },
        ],
      }),
    ]);

    const seekTo = vi.fn();
    const playVideo = vi.fn();
    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return { seekTo, playVideo, destroy: vi.fn(), getCurrentTime: vi.fn(() => 754) };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // Clicking the row BODY (not pencil/trash) seeks the live player and highlights the row.
    const noteARow = screen.getByText('note A').closest('button')!;
    await user.click(noteARow);
    await waitFor(() => expect(seekTo).toHaveBeenCalledWith(30, true));
    expect(noteARow).toHaveClass('bg-accent');

    // Editing (then canceling) a DIFFERENT row must not change the selection or re-seek.
    await user.click(screen.getByLabelText('Edit timestamp 1:30'));
    await user.click(screen.getByLabelText('Cancel timestamp edit'));

    expect(noteARow).toHaveClass('bg-accent');
    expect(seekTo).toHaveBeenCalledTimes(1);
  });

  it('shows an Edit affordance on the metadata card; editing and saving persists a full carry-through PATCH', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        notes: 'existing notes',
        vodTimestamps: [{ seconds: 30, note: 'note A' }],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) The read-only card shows an Edit affordance; clicking it renders the inline form.
    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    expect(screen.getByRole('radio', { name: 'Win' })).toBeInTheDocument();

    // (2) Changing a field (result win -> loss) and saving PATCHes once with the full carry-through input.
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.win).toBe(false);
    // notes/vodTimestamps/gsp from the fixture are preserved (carry-through).
    expect(input.notes).toBe('existing notes');
    expect(input.gsp).toBe(1_234_567);
    expect(input.vodTimestamps).toEqual([{ seconds: 30, note: 'note A' }]);

    // (3) Save returns to the read-only view.
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
  });

  it('returns to the read-only view without a mutation on Cancel', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateMatch).not.toHaveBeenCalled();
    expect(screen.getByText('vs. rival-one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
  });

  it('disables sync-owned fields but keeps notes/vodUrl/vodStartSeconds/gsp editable for a synced match', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        source: 'startgg',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));

    // Sync-owned controls are disabled (mirrors changesSyncOwnedFields).
    expect(screen.getByRole('combobox', { name: 'Your Fighter' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Win' })).toBeDisabled();

    // Annotation fields stay editable.
    expect(screen.getByRole('textbox', { name: 'Notes' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'VOD URL' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'GSP after match (optional)' })).not.toBeDisabled();
  });

  it('fills the VOD start-time field from the live position via "Use current player time"', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('button', { name: 'Use current player time' }));

    expect(screen.getByRole('textbox', { name: 'Match start time in VOD' })).toHaveValue('12:34');
  });

  it('renders match tag chips and adds a preset tag via the combobox, carrying other fields through', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        gsp: 1_234_567,
        tags: ['practice-friendlies'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    // (1) The existing preset tag renders as a chip with its translated label
    // (scoped via the chip's unique remove-button accessible name — the tag
    // filter row in VodMatchList also renders "Practice/Friendlies" as a
    // toggle chip, so a plain text query would be ambiguous).
    expect(
      await screen.findByRole('button', { name: 'Remove tag Practice/Friendlies' }),
    ).toBeInTheDocument();

    // (2) Opening the add-combobox and picking another preset PATCHes with
    // both tags, carrying gsp/vodTimestamps through unchanged.
    await user.click(screen.getByRole('combobox', { name: 'Add a tag' }));
    await user.click(await screen.findByRole('option', { name: 'Bad Matchup' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input.tags).toEqual(['practice-friendlies', 'bad-matchup']);
    expect(input.gsp).toBe(1_234_567);
  });

  it('removes a match tag via the chip X, omitting tags from the payload when it was the last one', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        tags: ['practice-friendlies'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(await screen.findByRole('button', { name: 'Remove tag Practice/Friendlies' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [id, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m1');
    expect(input).not.toHaveProperty('tags');
  });

  it('carries match tags through a match-detail edit save even when the VOD link is cleared', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
        vodTimestamps: [{ seconds: 30, note: 'note A' }],
        tags: ['to-review'],
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const vodUrlInput = screen.getByRole('textbox', { name: 'VOD URL' });
    await user.clear(vodUrlInput);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const [, input] = updateMatch.mock.calls[0] as [string, Record<string, unknown>];
    // vodTimestamps are dropped (VOD link cleared) but the match tag survives.
    expect(input).not.toHaveProperty('vodTimestamps');
    expect(input.tags).toEqual(['to-review']);
  });

  it('does not remount the player when editing match metadata', async () => {
    const user = userEvent.setup();
    listMatches.mockResolvedValue([
      makeMatch({
        id: 'm1',
        opponent: 'rival-one',
        vodUrl: 'https://youtube.com/watch?v=abc123',
      }),
    ]);

    let capturedConfig: YouTubePlayerConfig | undefined;
    const Player = vi.fn(function (
      this: unknown,
      _el: HTMLElement,
      config: YouTubePlayerConfig,
    ): YouTubePlayerInstance {
      capturedConfig = config;
      return {
        seekTo: vi.fn(),
        playVideo: vi.fn(),
        destroy: vi.fn(),
        getCurrentTime: vi.fn(() => 754),
      };
    });
    window.YT = { Player: Player as unknown as YTGlobal['Player'] };

    renderVodManager('/vod?match=m1');
    await waitFor(() => expect(Player).toHaveBeenCalledTimes(1));
    act(() => {
      capturedConfig?.events?.onReady?.();
    });

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    await user.click(screen.getByRole('radio', { name: 'Loss' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(Player).toHaveBeenCalledTimes(1);
  });
});
