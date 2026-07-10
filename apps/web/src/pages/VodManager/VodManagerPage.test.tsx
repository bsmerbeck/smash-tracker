import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
});
