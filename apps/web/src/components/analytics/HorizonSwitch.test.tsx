import fs, { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { analyticsSelectionStorageKey } from '@/lib/analyticsSelection';
import { HorizonSwitch } from './HorizonSwitch';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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

const list = vi.fn();
const aliasesList = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: (...args: unknown[]) => upsertMe(...args) },
    matches: { list: (...args: unknown[]) => list(...args) },
    opponents: { aliases: { list: (...args: unknown[]) => aliasesList(...args) } },
  },
}));

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: 'none',
    ...overrides,
  };
}

const manualMatch = () => makeMatch({ id: 'm1', time: Date.now(), win: true });
const tournamentMatch = () =>
  makeMatch({ id: 'm1', time: Date.now(), win: true, eventName: 'Genesis 10', source: 'startgg' });

function seedHorizon(uid: string, clientId: string | null, horizon: unknown) {
  window.localStorage.setItem(
    analyticsSelectionStorageKey(uid, clientId),
    JSON.stringify({ horizon }),
  );
}

function renderSwitch() {
  window.history.pushState({}, '', '/');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <HorizonSwitch />
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitForSettled() {
  // The switch has no isLoading testid of its own — wait for the radiogroup
  // (rendered only once useHorizon settles) instead.
  await waitFor(() => expect(screen.getByRole('radiogroup')).toBeInTheDocument());
}

describe('HorizonSwitch', () => {
  beforeEach(async () => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    aliasesList.mockResolvedValue({});
    window.localStorage.clear();
    window.history.pushState({}, '', '/');
    setMockUser(makeMockUser());
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    window.history.pushState({}, '', '/');
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('renders exactly three segments in the fixed declared order in English', async () => {
    list.mockResolvedValue([manualMatch()]);

    renderSwitch();
    await waitForSettled();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // The accessible name (pinned via `aria-label`), not raw `textContent`
    // — jsdom never loads the stylesheet, so the CSS-only short/full span
    // toggle is invisible to it and `textContent` would see BOTH spans at
    // once regardless of viewport.
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Last 30 games',
      'Last event',
      'Last 90 days',
    ]);
  });

  it('renders the same three-segment order under a long-label locale (German)', async () => {
    list.mockResolvedValue([manualMatch()]);
    await i18n.changeLanguage('de');

    renderSwitch();
    await waitForSettled();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Letzte 30 Matches',
      'Letztes Event',
      'Letzte 90 Tage',
    ]);
  });

  it('exposes radiogroup semantics labelled by its overline element', async () => {
    list.mockResolvedValue([manualMatch()]);

    renderSwitch();
    await waitForSettled();

    const group = screen.getByRole('radiogroup');
    expect(group).toHaveAccessibleName('Recent window');
  });

  it('arrow-key navigation moves the active segment and space selects it', async () => {
    list.mockResolvedValue([tournamentMatch()]);

    renderSwitch();
    await waitForSettled();

    const user = userEvent.setup();
    const last30 = screen.getByRole('radio', { name: 'Last 30 games' });
    last30.focus();

    await user.keyboard('{ArrowRight}');
    const lastEvent = screen.getByRole('radio', { name: 'Last event' });
    expect(lastEvent).toHaveFocus();

    await user.keyboard('{ }');
    await waitFor(() => expect(lastEvent).toHaveAttribute('aria-checked', 'true'));
  });

  it('a deselect activation on the already-selected segment leaves the resolved value unchanged and writes nothing', async () => {
    list.mockResolvedValue([manualMatch()]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderSwitch();
    await waitForSettled();

    const last30 = screen.getByRole('radio', { name: 'Last 30 games' });
    expect(last30).toHaveAttribute('aria-checked', 'true');

    const user = userEvent.setup();
    await user.click(last30);

    expect(last30).toHaveAttribute('aria-checked', 'true');
    expect(
      setItemSpy.mock.calls.filter((call) => String(call[0]).includes('analyticsSelection')),
    ).toHaveLength(0);
  });

  it('marks the last-event option disabled with its tooltip text when no tournament games exist, and resolves to the default with no write', async () => {
    seedHorizon('test-uid', null, 'lastEvent');
    list.mockResolvedValue([manualMatch()]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderSwitch();
    await waitForSettled();

    const lastEvent = screen.getByRole('radio', { name: 'Last event' });
    expect(lastEvent).toHaveAttribute('aria-disabled', 'true');

    const last30 = screen.getByRole('radio', { name: 'Last 30 games' });
    expect(last30).toHaveAttribute('aria-checked', 'true');
    expect(
      setItemSpy.mock.calls.filter((call) => String(call[0]).includes('analyticsSelection')),
    ).toHaveLength(0);

    const user = userEvent.setup();
    await user.hover(lastEvent);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('No events recorded');
  });

  it('selecting the disabled last-event option performs no write', async () => {
    list.mockResolvedValue([manualMatch()]);
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    renderSwitch();
    await waitForSettled();

    const lastEvent = screen.getByRole('radio', { name: 'Last event' });
    const user = userEvent.setup();
    await user.click(lastEvent);

    expect(lastEvent).toHaveAttribute('aria-checked', 'false');
    expect(
      setItemSpy.mock.calls.filter((call) => String(call[0]).includes('analyticsSelection')),
    ).toHaveLength(0);
  });

  it('exactly one element in the control carries the accent-underline class, on the selected segment', async () => {
    list.mockResolvedValue([manualMatch()]);

    const { container } = renderSwitch();
    await waitForSettled();

    const accents = container.querySelectorAll('[data-slot="horizon-switch-accent"]');
    expect(accents).toHaveLength(1);
    const last30 = screen.getByRole('radio', { name: 'Last 30 games' });
    expect(last30.contains(accents[0] ?? null)).toBe(true);
  });

  it('every transition utility in the source is paired with its reduced-motion counterpart', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/HorizonSwitch.tsx'),
      'utf8',
    );
    const transitionLines = source
      .split('\n')
      .filter((line) => /\btransition-[a-z-]+/.test(line) || /\bduration-\S+/.test(line));
    expect(transitionLines.length).toBeGreaterThan(0);
    for (const line of transitionLines) {
      expect(line).toContain('motion-reduce:');
    }
  });

  it('declares no local selected state — a source scan finds no useState holding a horizon value', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/analytics/HorizonSwitch.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/useState/);
  });

  it('the choice list is derived from the closed HorizonKey union — a fourth value fails to typecheck', () => {
    const order: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90'];
    // @ts-expect-error - 'last10' is not a member of the closed HorizonKey union; a fourth choice cannot be added without a HorizonKey revision.
    const invalidOrder: readonly HorizonKey[] = ['last30', 'lastEvent', 'last90', 'last10'];
    expect(order).toHaveLength(3);
    expect(invalidOrder).toHaveLength(4);
  });

  it('renders no HorizonSwitch usage under components/charts (D-06: never a per-chart control)', () => {
    // Structural guard mirrored at the plan-verification level too
    // (`grep -rn "HorizonSwitch" apps/web/src/components/charts/`); this
    // in-suite copy keeps the assertion runnable under `vitest run` alone.
    const chartsDir = resolve(process.cwd(), 'src/components/charts');
    let hasMatch = false;
    try {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(ts|tsx)$/.test(entry.name)) {
            const text = fs.readFileSync(full, 'utf8');
            if (text.includes('HorizonSwitch')) hasMatch = true;
          }
        }
      };
      walk(chartsDir);
    } catch {
      // Directory absent — nothing to scan, no match.
    }
    expect(hasMatch).toBe(false);
  });
});
