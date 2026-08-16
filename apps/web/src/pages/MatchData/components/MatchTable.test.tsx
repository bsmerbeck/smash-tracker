import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { MatchTable } from './MatchTable';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

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

import { AuthProvider } from '@/context/AuthContext';

const enrichmentAttribution = vi.fn();
const removeMatch = vi.fn().mockResolvedValue(undefined);
const clearVod = vi.fn().mockResolvedValue({});
const updateMatch = vi.fn().mockResolvedValue({});

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      enrichmentAttribution: (...args: unknown[]) => enrichmentAttribution(...args),
    },
    matches: {
      remove: (...args: unknown[]) => removeMatch(...args),
      clearVod: (...args: unknown[]) => clearVod(...args),
      update: (...args: unknown[]) => updateMatch(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 2, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  } as Match;
}

/**
 * `waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled())` only
 * proves the mocked queryFn was INVOKED — it fires synchronously on mount,
 * well before the mocked promise settles and React re-renders with the
 * resolved data. Awaiting the mock's own returned promise inside `act`
 * flushes that resolution (and the state update it triggers) before the
 * next interaction, so a click that follows never races the query's
 * pending -> success transition.
 */
async function settleEnrichmentAttribution() {
  await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
  await act(async () => {
    await enrichmentAttribution.mock.results[0]!.value;
  });
}

/**
 * Radix's `DropdownMenu` occasionally misses a `userEvent.click` that lands
 * mid-render (this suite's attribution query resolving concurrently with
 * the click is exactly that window) — the click is delivered but the
 * pointer-event sequence Radix listens for doesn't register as an "open"
 * toggle, and `findByRole('menu')` then times out with no menu ever having
 * opened. Retrying the click (bounded, via `waitFor`) is safe here because a
 * genuinely-missed click leaves the trigger's `data-state` at `closed` —
 * clicking again opens it; it only risks toggling a menu shut if the FIRST
 * click actually succeeded, which the `data-state` check below rules out
 * before ever retrying.
 */
async function openDropdownMenu(triggerName: string) {
  const user = userEvent.setup();
  await waitFor(
    async () => {
      const trigger = screen.getByRole('button', { name: triggerName });
      if (trigger.getAttribute('data-state') !== 'open') {
        await user.click(trigger);
      }
      expect(screen.getByRole('menu')).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  return screen.getByRole('menu');
}

function renderTable(matches: Match[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MatchTable matches={matches} fighterSprites={[mario, luigi]} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MatchTable — Liquipedia attribution (Phase 30.2 Plan 11, ENR-09)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    enrichmentAttribution.mockResolvedValue({ attributions: [] });
  });

  it('renders no attribution badge and no source-link item for an un-enriched account (byte-identical to today)', async () => {
    renderTable([makeMatch({ id: 'm1', vodUrl: 'https://youtu.be/abc123' })]);

    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.queryByTestId('liquipedia-attribution-badge')).not.toBeInTheDocument();

    const menu = await openDropdownMenu('Watch VOD');
    expect(within(menu).queryByText('View source')).not.toBeInTheDocument();
  });

  it('renders the stage value plus the attribution badge for a row whose stage came from Liquipedia', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'm1',
          stage: {
            sourcePageUrl: 'https://liquipedia.net/smash/Some_Page',
            rawStage: 'Battlefield',
            stageForm: 'normal',
          },
        },
      ],
    });
    renderTable([makeMatch({ id: 'm1' })]);

    expect(await screen.findByTestId('liquipedia-attribution-badge')).toBeInTheDocument();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.getByText('Stage data from Liquipedia')).toBeInTheDocument();
  });

  it('renders no badge for a row whose stage came from start.gg (a VOD-only entry has no stage half)', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        { matchKey: 'm1', vod: { sourcePageUrl: 'https://liquipedia.net/smash/Some_Page' } },
      ],
    });
    renderTable([makeMatch({ id: 'm1' })]);

    await settleEnrichmentAttribution();
    expect(screen.getByText('Battlefield')).toBeInTheDocument();
    expect(screen.queryByTestId('liquipedia-attribution-badge')).not.toBeInTheDocument();
  });

  it('still renders the existing visible unknown label for a row with no stage from either source', async () => {
    renderTable([makeMatch({ id: 'm1', map: undefined })]);
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('shows a source-link item in the VOD menu alongside the existing items when the VOD came from Liquipedia, and the existing items are unchanged', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        { matchKey: 'm1', vod: { sourcePageUrl: 'https://liquipedia.net/smash/Some_Page' } },
      ],
    });
    renderTable([makeMatch({ id: 'm1', vodUrl: 'https://youtu.be/abc123' })]);
    await settleEnrichmentAttribution();

    const menu = await openDropdownMenu('Watch VOD');
    expect(within(menu).getByText('Go to VOD Manager')).toBeInTheDocument();
    expect(within(menu).getByText('Edit VOD link')).toBeInTheDocument();
    expect(within(menu).getByText('Remove VOD link')).toBeInTheDocument();
    expect(within(menu).getByText('View source')).toBeInTheDocument();
  });

  // 30.2 gap-closure BLOCKER 2 --------------------------------------------

  it('shows NO source-link item in the VOD menu for a STAGE-only-enriched row whose VOD the user typed themselves', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'm1',
          stage: {
            sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page',
            rawStage: 'Battlefield',
            stageForm: 'normal',
          },
        },
      ],
    });
    renderTable([makeMatch({ id: 'm1', vodUrl: 'https://youtu.be/user-typed' })]);
    await settleEnrichmentAttribution();

    const menu = await openDropdownMenu('Watch VOD');
    expect(within(menu).queryByText('View source')).not.toBeInTheDocument();
    // The stage badge still renders — the two halves are independent.
    expect(screen.getByTestId('liquipedia-attribution-badge')).toBeInTheDocument();
  });

  it("the stage badge's href is the STAGE page even when the row's VOD came from a different page", async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'm1',
          stage: {
            sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page',
            rawStage: 'Battlefield',
            stageForm: 'normal',
          },
          vod: { sourcePageUrl: 'https://liquipedia.net/smash/Vod_Page' },
        },
      ],
    });
    renderTable([makeMatch({ id: 'm1', vodUrl: 'https://youtu.be/abc123' })]);

    const anchor = await screen.findByTestId('liquipedia-attribution-link');
    expect(anchor).toHaveAttribute('href', 'https://liquipedia.net/smash/Bracket_Page');
  });
});

describe('MatchTable — character evidence (Phase 30.3 Gate 5)', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    enrichmentAttribution.mockResolvedValue({ attributions: [] });
  });

  it('renders no character evidence for an un-enriched row (byte-identical to today)', async () => {
    renderTable([makeMatch({ id: 'm1' })]);
    await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
    expect(screen.queryByTestId('liquipedia-character-evidence')).not.toBeInTheDocument();
  });

  it("renders the subject-first 'X vs Y' character evidence, with sprites, when both ids resolve", async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'm1',
          characters: {
            subjectRaw: 'Mario',
            opponentRaw: 'Luigi',
            subjectFighterId: mario.id,
            opponentFighterId: luigi.id,
          },
        },
      ],
    });
    renderTable([makeMatch({ id: 'm1' })]);

    const evidence = await screen.findByTestId('liquipedia-character-evidence');
    expect(evidence.textContent).toContain('Mario');
    expect(evidence.textContent).toContain('Luigi');
    expect(screen.getByText('Character data from Liquipedia')).toBeInTheDocument();
  });

  it('falls back to the raw source text for an unmapped character id', async () => {
    enrichmentAttribution.mockResolvedValue({
      attributions: [
        {
          matchKey: 'm1',
          characters: { subjectRaw: 'Some Unrecognized Tag', opponentRaw: 'Luigi' },
        },
      ],
    });
    renderTable([makeMatch({ id: 'm1' })]);

    expect(await screen.findByText('Some Unrecognized Tag')).toBeInTheDocument();
  });
});
