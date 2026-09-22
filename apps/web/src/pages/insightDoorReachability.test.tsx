import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { INSIGHT_TEMPLATES, type InsightTemplateId } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { writeStoredDismissals } from '@/lib/insightDismissals';
import { FighterAnalysisPage } from './FighterAnalysis/FighterAnalysisPage';
import { MatchDataPage } from './MatchData/MatchDataPage';
import { MatchupsPage } from './Matchups/MatchupsPage';
import { TrendsPage } from './Trends/TrendsPage';
import { OpponentHubPage } from './Opponents/OpponentHubPage';
import { useProfile } from '@/hooks/useProfile';
import {
  INSIGHT_DOOR_HOSTS,
  type InsightDoorHost,
  type InsightDoorHostFixture,
} from '@/test/insightDoorHosts';

/**
 * Plan 39.1-29 (gap closure, SC4/INS-04): the page-level reachability
 * oracle. Copies `insightCoachParity.test.tsx`'s firebase/`@/lib/api` mocks
 * and its personal/coach/workspace `MemoryRouter` harness. Registry-driven
 * throughout — `INSIGHT_DOOR_HOSTS` (from `@/test/insightDoorHosts`) and
 * `INSIGHT_TEMPLATES` (the shared registry) drive every `describe.each`
 * below; no hand-written template-id list exists in this file.
 *
 * NEVER mocks `buildInsightDoors`, `resolveInsightClaim`, `FilteredMatchList`,
 * the insight engine, or any page component — only the `@/lib/api` /
 * firebase boundary the existing page tests already mock. Every door href
 * is read from the rendered DOM, never hand-written.
 */

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

// Union of every `api.*` call site reached by the five host pages this
// suite mounts (FighterAnalysis, MatchData, Matchups, Trends, OpponentHub) —
// mirrors `insightCoachParity.test.tsx`'s own union mock.
const getFighters = vi.fn();
const listMatches = vi.fn();
const listOpponents = vi.fn();
const listTournaments = vi.fn();
const listAliases = vi.fn();
const upsertAlias = vi.fn();
const removeAlias = vi.fn();
const listNotes = vi.fn();
const upsertNote = vi.fn();
const removeNote = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn();
const updateMatch = vi.fn();
const deleteMatch = vi.fn();
const clearVod = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();
const deleteNote = vi.fn();
const getStageFavorites = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      getMe: (...args: unknown[]) => getMe(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
      remove: (...args: unknown[]) => deleteMatch(...args),
      clearVod: (...args: unknown[]) => clearVod(...args),
      createNote: (...args: unknown[]) => createNote(...args),
      updateNote: (...args: unknown[]) => updateNote(...args),
      deleteNote: (...args: unknown[]) => deleteNote(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
      aliases: {
        list: (...args: unknown[]) => listAliases(...args),
        upsert: (...args: unknown[]) => upsertAlias(...args),
        remove: (...args: unknown[]) => removeAlias(...args),
      },
      notes: {
        list: (...args: unknown[]) => listNotes(...args),
        upsert: (...args: unknown[]) => upsertNote(...args),
        remove: (...args: unknown[]) => removeNote(...args),
      },
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    stageFavorites: {
      get: (...args: unknown[]) => getStageFavorites(...args),
    },
  },
}));

/** Phase 30.3 (Gate 6 corrective): stands in for the app shell's own `GET /api/users/me` subscription — MatchDataPage/OpponentHubPage read demo-gated affordances off it. */
function ShellProfileSubscription() {
  useProfile();
  return null;
}

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="reachability-location-probe">{`${pathname}${search}`}</div>;
}

function defaultProfile() {
  return {
    uid: 'test-uid',
    email: 'test@example.com',
    fighters: { primary: [], secondary: [] },
    coachingModeEnabled: false,
    onboardingIntent: null,
  };
}

function renderHostRoute(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <AnalyticsFilterProvider>
            <TooltipProvider>
              <ShellProfileSubscription />
              <LocationProbe />
              <Routes>
                <Route path="/fighter-analysis" element={<FighterAnalysisPage />} />
                <Route path="/coach/:clientId/fighter-analysis" element={<FighterAnalysisPage />} />
                <Route
                  path="/workspace/:tenantId/fighter-analysis"
                  element={<FighterAnalysisPage />}
                />
                <Route path="/match-data" element={<MatchDataPage />} />
                <Route path="/coach/:clientId/match-data" element={<MatchDataPage />} />
                <Route path="/workspace/:tenantId/match-data" element={<MatchDataPage />} />
                <Route path="/matchups" element={<MatchupsPage />} />
                <Route path="/coach/:clientId/matchups" element={<MatchupsPage />} />
                <Route path="/workspace/:tenantId/matchups" element={<MatchupsPage />} />
                <Route path="/opponents/:opponentTag" element={<OpponentHubPage />} />
                <Route
                  path="/coach/:clientId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
                <Route
                  path="/workspace/:tenantId/opponents/:opponentTag"
                  element={<OpponentHubPage />}
                />
                <Route path="/trends" element={<TrendsPage />} />
              </Routes>
            </TooltipProvider>
          </AnalyticsFilterProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Resolves an `InsightDoorHost.doorRegion` — either a plain CSS selector, or (prefixed `text:`) a card-title text located via `getByText(...).closest('[data-slot="card"]')`. */
async function resolveDoorRegion(doorRegion: string): Promise<HTMLElement> {
  if (doorRegion.startsWith('text:')) {
    const title = doorRegion.slice('text:'.length);
    const el = await screen.findByText(title);
    const card = el.closest('[data-slot="card"]');
    if (!card)
      throw new Error(`doorRegion "${doorRegion}": no ancestor [data-slot="card"] for "${title}"`);
    return card as HTMLElement;
  }
  return waitFor(() => {
    const el = document.querySelector(doorRegion);
    if (!el) throw new Error(`doorRegion "${doorRegion}" not found`);
    return el as HTMLElement;
  });
}

/** Finds, within `region`, the link whose href's `claim` query param starts with `<templateId>:` — decoding the query string so a percent-encoded `:` (`%3A`) never causes a false miss. */
function findDoorForTemplate(region: HTMLElement, templateId: InsightTemplateId): HTMLElement {
  const links = within(region).getAllByRole('link');
  for (const link of links) {
    const href = link.getAttribute('href') ?? '';
    const queryPart = href.split('?')[1]?.split('#')[0] ?? '';
    const params = new URLSearchParams(queryPart);
    const claim = params.get('claim');
    if (claim && claim.startsWith(`${templateId}:`)) {
      return link;
    }
  }
  throw new Error(
    `no door for template "${templateId}" found among ${links.length} link(s) in region (hrefs: ${links
      .map((l) => l.getAttribute('href'))
      .join(', ')})`,
  );
}

function seedDismissals(uid: string, clientId: string | null, ids: string[] | undefined) {
  if (ids && ids.length > 0) {
    writeStoredDismissals(uid, clientId, ids);
  }
}

function applyMocks(fixture: InsightDoorHostFixture) {
  getFighters.mockResolvedValue({ primary: [fixture.primaryFighterId], secondary: [] });
  listMatches.mockResolvedValue(fixture.matches);
}

/**
 * The generic round-trip proof: render the host's route (personal or
 * subject-mounted), find the door for `templateId` inside `host.doorRegion`,
 * click it, and assert the terminus root's `data-total-rows` AND the
 * active-filter summary line both equal the door's own printed n. Also
 * asserts the location after the click keeps `mountPrefix` (coach/workspace
 * parity, T-39.1-29-01).
 */
async function expectDoorLandsOnExactN(params: {
  templateId: InsightTemplateId;
  host: InsightDoorHost;
  mountPrefix?: string;
  fixtureOverride?: InsightDoorHostFixture;
  clientId?: string | null;
}) {
  const { templateId, host, mountPrefix = '', fixtureOverride, clientId = null } = params;
  const fixture = fixtureOverride ?? host.fixture();
  applyMocks(fixture);
  seedDismissals('test-uid', clientId, fixture.dismissIds);
  const user = userEvent.setup();
  HTMLElement.prototype.scrollIntoView = vi.fn();

  const search = fixture.search ?? '';
  const basePath = host.personalPath.split('?')[0];
  const baseSearch = host.personalPath.includes('?') ? `?${host.personalPath.split('?')[1]}` : '';
  const entry = `${mountPrefix}${basePath}${search || baseSearch}`;

  renderHostRoute(entry);

  const region = await resolveDoorRegion(host.doorRegion);
  const door = findDoorForTemplate(region, templateId);
  const doorLabel = door.textContent ?? '';
  const expectedCount = Number((doorLabel.match(/\d+/) ?? ['0'])[0]);
  expect(expectedCount, `door label "${doorLabel}" carried no positive count`).toBeGreaterThan(0);

  await user.click(door);

  const terminus = (await waitFor(() => {
    const el = document.getElementById(host.terminusAnchorId);
    if (!el) throw new Error(`#${host.terminusAnchorId} did not mount after clicking the door`);
    return el;
  })) as HTMLElement;
  await waitFor(() => {
    const table = within(terminus).getByRole('table');
    expect(Number(table.getAttribute('data-total-rows'))).toBe(expectedCount);
  });
  const summaryParagraph = terminus.querySelector('p.text-sm.text-muted-foreground');
  expect(
    summaryParagraph,
    `no active-filter summary paragraph (p.text-sm.text-muted-foreground) inside #${host.terminusAnchorId}`,
  ).not.toBeNull();
  expect(summaryParagraph?.textContent ?? '').toContain(String(expectedCount));

  if (mountPrefix) {
    await waitFor(() => {
      const probe = screen.getByTestId('reachability-location-probe').textContent ?? '';
      expect(probe.startsWith(mountPrefix)).toBe(true);
    });
  }
}

beforeEach(() => {
  resetAuthMock();
  vi.clearAllMocks();
  window.localStorage.clear();
  upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
  getMe.mockResolvedValue(defaultProfile());
  listOpponents.mockResolvedValue([]);
  listTournaments.mockResolvedValue([]);
  listAliases.mockResolvedValue({});
  upsertAlias.mockResolvedValue({});
  removeAlias.mockResolvedValue(undefined);
  listNotes.mockResolvedValue({});
  upsertNote.mockResolvedValue({ updatedAt: 1 });
  removeNote.mockResolvedValue(undefined);
  getStageFavorites.mockResolvedValue({ stageIds: [], updatedAt: 0 });
  setMockUser(makeMockUser());
});

describe('registry coverage', () => {
  it('INSIGHT_DOOR_HOSTS covers exactly the registry INSIGHT_TEMPLATES ids, every entry non-empty', () => {
    expect(INSIGHT_TEMPLATES).toHaveLength(17);
    expect(new Set(Object.keys(INSIGHT_DOOR_HOSTS))).toEqual(
      new Set(INSIGHT_TEMPLATES.map((t) => t.id)),
    );
    for (const [templateId, hosts] of Object.entries(INSIGHT_DOOR_HOSTS)) {
      expect(hosts.length, `${templateId} has zero live hosts`).toBeGreaterThan(0);
    }
  });
});

describe('T-39.1-29: formNow on the Fighter hero (personal) — the round trip', () => {
  it("the hero's counted-games door lands on exactly N, proven through a real render", async () => {
    const host = INSIGHT_DOOR_HOSTS.formNow[0]!;
    await expectDoorLandsOnExactN({ templateId: 'formNow', host });
  });
});
