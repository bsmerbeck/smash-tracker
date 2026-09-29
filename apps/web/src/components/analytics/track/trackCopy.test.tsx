import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import i18n from '@/i18n';
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
