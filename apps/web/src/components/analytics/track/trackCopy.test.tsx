import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import {
  resolveTournamentTier,
  type DigestMovedToken,
  type Match,
  type TournamentEntry,
} from '@smash-tracker/shared';
import i18n from '@/i18n';
import type { UseDigestResult } from '@/hooks/useDigest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RecapCandidate } from '@/hooks/useRecapCandidate';
import { DigestCard } from './DigestCard';
import { RecapCard } from './RecapCard';
import type { TrackedRowModel } from './trackedRowModel';
import { TrackedSection } from './TrackedSection';

/**
 * G4 (UI-SPEC §13, the "copy-params render test" lesson): the Tracked
 * section's copy and the Track toasts are rendered through the REAL six
 * locale files. No interpolation placeholder may survive into the DOM or an
 * accessible name, and no raw item key, fighter id, stage id or uid may stand
 * where a name belongs. A locale that drops or renames a `{{token}}` leaves a
 * literal placeholder behind and fails here.
 */

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const RAW_UID = 'user-raw-uid-7431';
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: RAW_UID } }) }));

// Plan 39.2-13: the recap's debrief door reads the server's brief status; here it is open.
vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: (entryKey: string | undefined) =>
    entryKey === undefined
      ? { isSuccess: false, isPending: true, data: undefined }
      : {
          isSuccess: true,
          isPending: false,
          data: { activated: true, reviewAt: Date.now() - 1000 },
        },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja'] as const;
const MARIO = 1;
const LUIGI = 10;
const NAME = 'MkLeo';

const fetchMock = vi.fn();
let serverItems: { itemKey: string; item: Record<string, unknown> }[] = [];
let watchlistStatus = 200;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installServer() {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).includes('/api/opponents/aliases')) {
      return Promise.resolve(jsonResponse({}));
    }
    return Promise.resolve(
      watchlistStatus === 200
        ? jsonResponse({ items: serverItems })
        : jsonResponse(
            { error: 'x', message: 'boom', statusCode: watchlistStatus },
            watchlistStatus,
          ),
    );
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function history(): Match[] {
  const now = Date.now();
  return Array.from({ length: 40 }, (_, i) => ({
    id: `g-${i}`,
    fighter_id: MARIO,
    opponent_id: LUIGI,
    time: now - (40 - i) * DAY_MS + DAY_MS / 2,
    win: (i * 7) % 18 < 7,
    opponent: 'mkleo',
    map: { id: 1, name: 'Battlefield' },
  })) as Match[];
}

const POPULATED = [
  { itemKey: 'opponent:mkleo', item: { kind: 'opponent', ref: 'mkleo', createdAt: 1 } },
  {
    itemKey: `matchup:${MARIO}-${LUIGI}`,
    item: { kind: 'matchup', ref: { fighterId: MARIO, vsFighterId: LUIGI }, createdAt: 2 },
  },
  { itemKey: 'stage:1', item: { kind: 'stage', ref: 1, createdAt: 3 } },
];

/** Every string the reader can see or hear inside `root`: text plus every accessible-name-ish attribute. */
function visibleAndAccessibleText(root: HTMLElement): string {
  const attributes = Array.from(root.querySelectorAll('[aria-label], [title], img[alt]')).flatMap(
    (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')],
  );
  return [root.textContent ?? '', ...attributes.filter((value): value is string => !!value)].join(
    '\n',
  );
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TrackedSection matches={history()} horizon="last30" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Tracked section copy through the real locale files (G4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    serverItems = [];
    watchlistStatus = 200;
    installServer();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('en');
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      it('populated: no placeholder, no raw key / id / uid, and the names are localised', async () => {
        await i18n.changeLanguage(locale);
        serverItems = POPULATED;
        const { container } = renderSection();
        await waitFor(() =>
          expect(container.querySelectorAll('[data-slot="tracked-row"]')).toHaveLength(3),
        );

        const text = visibleAndAccessibleText(container);
        expect(text).not.toContain('{{');
        expect(text).not.toContain('}}');
        expect(text).not.toContain('undefined');
        for (const raw of [
          'opponent:mkleo',
          `matchup:${MARIO}-${LUIGI}`,
          'stage:1',
          RAW_UID,
          `${MARIO}-${LUIGI}`,
        ]) {
          expect(text, `${locale} shows ${raw}`).not.toContain(raw);
        }
        // The matchup names its fighters in this locale, not by id.
        const mario = i18n.t(`fighterNames.${MARIO}`);
        const luigi = i18n.t(`fighterNames.${LUIGI}`);
        const matchupRow = container.querySelector('[data-kind="matchup"]')!;
        expect(matchupRow.textContent).toContain(mario);
        expect(matchupRow.textContent).toContain(luigi);
        // The header states the stored count in this locale's own words.
        expect(container.querySelector('[data-slot="tracked-count"]')?.textContent).toContain('3');
        expect(container.querySelector('[data-slot="tracked-count"]')?.textContent).toContain('25');
      });

      it('empty: the count and the muted line read cleanly', async () => {
        await i18n.changeLanguage(locale);
        const { container } = renderSection();
        await waitFor(() =>
          expect(container.querySelector('[data-slot="tracked-empty"]')).not.toBeNull(),
        );
        const text = visibleAndAccessibleText(container);
        expect(text).not.toContain('{{');
        expect(text).not.toContain('}}');
        expect(container.querySelector('[data-slot="tracked-empty"]')?.textContent?.trim()).toBe(
          i18n.t('watchlist.section.empty'),
        );
        expect(container.querySelector('[data-slot="tracked-count"]')?.textContent).toContain('0');
      });

      it('error: the load-error line renders as written in this locale', async () => {
        await i18n.changeLanguage(locale);
        watchlistStatus = 500;
        const { container } = renderSection();
        await waitFor(() =>
          expect(container.querySelector('[data-slot="tracked-error"]')).not.toBeNull(),
        );
        expect(container.querySelector('[data-slot="tracked-error"]')?.textContent?.trim()).toBe(
          i18n.t('watchlist.loadError'),
        );
        expect(visibleAndAccessibleText(container)).not.toContain('{{');
      });

      it('the Track toast strings carry the name and no placeholder', async () => {
        await i18n.changeLanguage(locale);
        for (const key of ['watchlist.trackedToast', 'watchlist.untrackedToast']) {
          const value = i18n.t(key, { name: NAME });
          expect(value, `${locale} ${key}`).toContain(NAME);
          expect(value).not.toContain('{{');
          expect(value).not.toContain('}}');
        }
        for (const key of ['watchlist.full', 'watchlist.manage', 'watchlist.error']) {
          const value = i18n.t(key);
          expect(value.trim(), `${locale} ${key}`).not.toBe('');
          expect(value).not.toContain('{{');
          expect(value).not.toBe(key);
        }
        for (const count of [0, 1, 7, 25]) {
          const value = i18n.t('watchlist.section.count', { count });
          expect(value, `${locale} count ${count}`).toContain(String(count));
          expect(value).not.toContain('{{');
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Plan 39.2-12 (G4): the digest's copy through the same six real locale files.
// ---------------------------------------------------------------------------------------------

const MOVED_TOKENS: DigestMovedToken[] = ['up', 'down', 'steady', 'unlocked', 'asserting'];

function movedModel(index: number, token: DigestMovedToken): TrackedRowModel {
  return {
    itemKey: `opponent:rival${index}`,
    itemKeys: [`opponent:rival${index}`],
    kind: 'opponent',
    name: `Rival${index}`,
    href: `/opponents/rival${index}`,
    stageThumbUrl: null,
    stageName: null,
    wins: 14,
    losses: 22,
    total: 36,
    chip: null,
    recentWins: 8,
    recentLosses: 4,
    strip: [],
    movedToken: token,
  };
}

function digestOf(overrides: Partial<UseDigestResult>): UseDigestResult {
  return {
    status: 'expanded',
    newGames: 41,
    newEvents: 2,
    movedCount: 7,
    movedRows: MOVED_TOKENS.map((token, i) => movedModel(i + 1, token)),
    moreCount: 2,
    movedByItemKey: new Map(),
    since: Date.UTC(2026, 8, 21, 12),
    visitLastSeenAt: null,
    snapshotReady: true,
    canMarkAsRead: true,
    markAsRead: () => undefined,
    ...overrides,
  };
}

function renderDigest(value: UseDigestResult) {
  return render(
    <MemoryRouter>
      <DigestCard digest={value} />
    </MemoryRouter>,
  );
}

describe('Digest copy through the real locale files (G4)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      it('expanded: counts, moved tokens, "and N more" and the device note carry no placeholder and no raw key', async () => {
        await i18n.changeLanguage(locale);
        const { container } = renderDigest(digestOf({}));
        const text = visibleAndAccessibleText(container);
        expect(text).not.toContain('{{');
        expect(text).not.toContain('}}');
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('opponent:rival');
        for (const token of MOVED_TOKENS) {
          expect(text, `${locale} moved.${token}`).toContain(i18n.t(`watchlist.moved.${token}`));
        }
        expect(text).toContain(i18n.t('digest.andMore', { count: 2 }));
        expect(text).toContain(i18n.t('digest.deviceNote'));
        expect(text).toContain(i18n.t('digest.markRead'));
        expect(text).toContain('41');
      });

      it('quiet and start: the line reads as written, the date is filled in, and there is no button', async () => {
        await i18n.changeLanguage(locale);
        const quiet = renderDigest(digestOf({ status: 'quiet', canMarkAsRead: false }));
        const quietText = visibleAndAccessibleText(quiet.container);
        expect(quietText).not.toContain('{{');
        expect(
          quiet.container.querySelector('[data-slot="insight-line"]')?.textContent,
        ).not.toMatch(/\{\{|NaN|Invalid/);
        expect(quiet.container.querySelector('button')).toBeNull();
        quiet.unmount();

        const start = renderDigest(
          digestOf({ status: 'start', since: null, canMarkAsRead: false }),
        );
        expect(
          start.container.querySelector('[data-slot="insight-line"]')?.textContent?.trim(),
        ).toBe(i18n.t('digest.start'));
        expect(start.container.querySelector('button')).toBeNull();
      });

      it('plural forms of "and N more" carry the count in this locale', async () => {
        await i18n.changeLanguage(locale);
        for (const count of [1, 2, 20]) {
          const value = i18n.t('digest.andMore', { count });
          expect(value, `${locale} andMore ${count}`).toContain(String(count === 1 ? '1' : count));
          expect(value).not.toContain('{{');
        }
      });
    });
  }
});

const RAW_ENTRY_KEY = 'sn26-raw-entry-key';

/** Nine games of "Supernova 2026": three sets, or none a parser can read when `parsableSets` is false. */
function recapGames(parsableSets: boolean): Match[] {
  const end = Date.now() - 3 * DAY_MS;
  return Array.from({ length: 9 }, (_, i) => ({
    id: `rg-${i}`,
    fighter_id: MARIO,
    opponent_id: LUIGI,
    time: end - (8 - i) * 60 * 1000,
    win: i % 3 !== 0,
    eventName: 'Supernova 2026',
    tournamentName: 'Supernova 2026',
    ...(parsableSets
      ? { externalId: `sgg:supernova-set${Math.floor(i / 3)}:g${(i % 3) + 1}`, opponent: NAME }
      : {}),
  })) as Match[];
}

function recapCandidate(games: Match[], withEntry: boolean): RecapCandidate {
  const newest = Math.max(...games.map((g) => g.time));
  const entry = {
    eventName: 'Supernova 2026',
    tournamentName: 'Supernova 2026',
    entryKey: RAW_ENTRY_KEY,
    firstSetAt: newest - 60 * 60 * 1000,
    lastSetAt: newest,
    setsPlayed: 3,
    placement: 3,
    numEntrants: 2048,
  } as TournamentEntry;
  return {
    eventKey: 'Supernova 2026',
    games,
    newestGameAt: newest,
    endMs: newest,
    dismissalId: `recap:${RAW_ENTRY_KEY}`,
    entry: withEntry
      ? {
          entry,
          entryKey: RAW_ENTRY_KEY,
          resolution: resolveTournamentTier({
            entry: { eventName: entry.eventName, numEntrants: 2048, isOnline: false },
            observedOnline: false,
          }),
          isAdminImported: false,
        }
      : null,
  };
}

function renderRecap(candidate: RecapCandidate, allMatches: Match[]) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <RecapCard
          recap={{ status: 'ready', candidate, dismiss: vi.fn() }}
          allMatches={allMatches}
          horizon="last30"
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('Recap card copy through the real locale files (plan 39.2-13, G4)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  const olderGames = (): Match[] =>
    Array.from({ length: 300 }, (_, i) => ({
      id: `hist-${i}`,
      fighter_id: MARIO,
      opponent_id: LUIGI,
      time: Date.now() - 60 * DAY_MS - i * 1000,
      win: i % 2 === 0,
    })) as Match[];

  function expectClean(locale: string, text: string) {
    expect(text, `${locale} placeholder`).not.toContain('{{');
    expect(text, `${locale} placeholder`).not.toContain('}}');
    expect(text, `${locale} undefined`).not.toContain('undefined');
    expect(text, `${locale} NaN`).not.toMatch(/NaN|Invalid Date/);
    expect(text, `${locale} raw entry key`).not.toContain(RAW_ENTRY_KEY);
    expect(text, `${locale} raw fighter id`).not.toMatch(/fighter_id|opponent_id|"id":/);
  }

  for (const locale of LOCALES) {
    describe(locale, () => {
      it('placement variant: the ordinal and entrants are filled in once, the doors and evidence read as written', async () => {
        await i18n.changeLanguage(locale);
        const games = recapGames(true);
        const { container } = renderRecap(recapCandidate(games, true), [...games, ...olderGames()]);
        const text = visibleAndAccessibleText(container);
        expectClean(locale, text);
        const verdict = container.querySelector('[data-slot="insight-card-verdict"]')?.textContent;
        expect(verdict).toContain('Supernova 2026');
        expect(verdict).toContain(
          i18n.t('tournaments.table.placement', { count: 3, ordinal: true }),
        );
        expect(verdict).toContain(new Intl.NumberFormat(locale).format(2048));
        // An ordinal is never doubled by a sentence that also spells its own suffix.
        expect(verdict).not.toMatch(/位位|Platz 3\./);
        expect(text).toContain(i18n.t('insights.door.debrief'));
        expect(text).toContain(i18n.t('insights.door.seeGames', { count: 9 }));
        expect(text).toContain(i18n.t('insights.door.openEvent'));
        const evidence = container.querySelector(
          '[data-slot="insight-card-evidence"]',
        )?.textContent;
        // 9 event games plus 300 older ones: the all-time sample the evidence names.
        expect(evidence).toContain('309');
      });

      it('games only: no entry and no parsable sets still reads as one sentence with no placeholder', async () => {
        await i18n.changeLanguage(locale);
        const games = recapGames(false);
        const { container } = renderRecap(recapCandidate(games, false), [
          ...games,
          ...olderGames(),
        ]);
        const text = visibleAndAccessibleText(container);
        expectClean(locale, text);
        expect(
          container.querySelector('[data-slot="insight-card-verdict"]')?.textContent,
        ).toContain('Supernova 2026');
        expect(text).not.toContain(i18n.t('insights.door.debrief'));
        expect(container.querySelector('[data-slot="set-strip"]')).toBeNull();
      });

      it('thin: a five-game event says so in the chip and asserts no direction', async () => {
        await i18n.changeLanguage(locale);
        const games = recapGames(true).slice(0, 5);
        const { container } = renderRecap(recapCandidate(games, true), [...games, ...olderGames()]);
        expectClean(locale, visibleAndAccessibleText(container));
        const chip = container.querySelector('[data-slot="delta-chip"]');
        expect(chip?.getAttribute('data-state')).toBe('thin');
        expect(chip?.textContent).toContain(i18n.t('insights.chip.noDirection', { count: 5 }));
      });
    });
  }
});
