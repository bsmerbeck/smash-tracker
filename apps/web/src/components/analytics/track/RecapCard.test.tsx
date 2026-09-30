import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import {
  resolveTournamentTier,
  type Match,
  type PrepBriefStatus,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RecapCandidate, RecapCandidateResult } from '@/hooks/useRecapCandidate';
import { RecapCard } from './RecapCard';
import { buildGamesDoorHref } from './recapGamesDoor';

interface PrepState {
  isSuccess: boolean;
  isPending: boolean;
  data: PrepBriefStatus | undefined;
}
let prepState: PrepState;
const usePrepBriefSpy = vi.fn((key: string | undefined) => {
  void key;
  return prepState;
});
vi.mock('@/hooks/usePrepBrief', () => ({
  usePrepBrief: (key: string | undefined) => usePrepBriefSpy(key),
}));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIGHTER = 8;

/** Three sets of three games: 2–1 (won), 3–0 (won), 0–3 (lost) = 5–4 in games, 2–1 in sets. */
function supernovaGames(endedAgoMs = 3 * DAY): Match[] {
  const now = Date.now();
  const games: Match[] = [];
  let time = now - endedAgoMs - 9 * HOUR;
  for (let s = 0; s < 3; s += 1) {
    for (let g = 0; g < 3; g += 1) {
      time += HOUR;
      const win = s === 0 ? g < 2 : s === 1;
      games.push({
        id: `sn-${s}-${g}`,
        fighter_id: FIGHTER,
        opponent_id: 2,
        time,
        win,
        matchType: 'offline-tourney',
        eventName: 'Supernova 2026',
        tournamentName: 'Supernova 2026',
        externalId: `sgg:supernova-set${s}:g${g + 1}`,
      } as Match);
    }
  }
  return games;
}

function older(count: number): Match[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`,
    fighter_id: FIGHTER,
    opponent_id: 2,
    time: now - 60 * DAY - i * HOUR,
    win: i % 2 === 0,
  })) as Match[];
}

function entryFixture(extra: Partial<TournamentEntry> = {}): TournamentEntry {
  const now = Date.now();
  return {
    eventName: 'Supernova 2026',
    tournamentName: 'Supernova 2026',
    entryKey: 'sn26',
    firstSetAt: now - 3 * DAY - 9 * HOUR,
    lastSetAt: now - 3 * DAY,
    setsPlayed: 3,
    placement: 3,
    numEntrants: 2048,
    ...extra,
  } as TournamentEntry;
}

function candidateOf(
  games: Match[],
  options: { entry?: Partial<TournamentEntry> | null; imported?: boolean } = {},
): RecapCandidate {
  const entry = options.entry === null ? null : entryFixture(options.entry);
  const newestGameAt = Math.max(...games.map((g) => g.time));
  return {
    eventKey: 'Supernova 2026',
    eventId: `event:["Supernova 2026","Supernova 2026"]@${Math.min(...games.map((g) => g.time))}`,
    games,
    newestGameAt,
    endMs: newestGameAt,
    dismissalId: entry ? 'recap:sn26' : 'recap:event:Supernova 2026',
    entry: entry
      ? {
          entry,
          entryKey: 'sn26',
          resolution: resolveTournamentTier({
            entry: { eventName: entry.eventName, numEntrants: 2048, isOnline: false },
            observedOnline: false,
          }),
          isAdminImported: options.imported ?? false,
          games,
        }
      : null,
  };
}

function recapOf(candidate: RecapCandidate, dismiss = vi.fn()): RecapCandidateResult {
  return { status: 'ready', candidate, dismiss };
}

function renderCard(
  recap: RecapCandidateResult,
  allMatches: Match[],
  path = '/dashboard',
  horizon: 'last30' | 'lastEvent' | 'last90' = 'last30',
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <RecapCard recap={recap} allMatches={allMatches} horizon={horizon} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function doorLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('[data-slot="insight-card-doors"] a'),
  );
}

describe('RecapCard (plan 39.2-13, TRK-03)', () => {
  beforeEach(() => {
    prepState = { isSuccess: false, isPending: true, data: undefined };
    usePrepBriefSpy.mockClear();
  });
  afterEach(cleanup);

  it('reads the placement sentence for an own-account event, with its tier badge and provenance', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    expect(
      screen.getByText('Supernova 2026 — 3rd of 2,048; 5–4 in games, 2–1 in sets.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-slot="tier-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="tier-provenance"]')).not.toBeNull();
    // The one sub line: the lost set, no opponent name means the record alone.
    expect(screen.getByText('Set loss — 0–3.')).toBeInTheDocument();
  });

  it('states the event record, the all-time rate and the sample cue on the evidence line', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const evidence = container.querySelector('[data-slot="insight-card-evidence"]');
    expect(evidence?.textContent).toMatch(/^5–4 at the event · \d+% all time over 409 · /);
  });

  it('a 5-game event reads thin: a count and no direction, never up or down', () => {
    const games = supernovaGames().slice(0, 5);
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const chip = container.querySelector('[data-slot="delta-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('thin');
    expect(chip?.getAttribute('data-recent-games')).toBe('5');
    expect(chip?.textContent).toContain('no direction');
    expect(container.querySelector('[data-state="up"], [data-state="down"]')).toBeNull();
  });

  it('draws no chip when the event is most of the history (the engine collapses it)', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), games);
    expect(container.querySelector('[data-slot="delta-chip"]')).toBeNull();
  });

  it('draws the set strip as one tick per set, named as an image', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const strip = container.querySelector('[data-slot="set-strip"]');
    expect(strip?.getAttribute('role')).toBe('img');
    expect(strip?.children).toHaveLength(3);
    expect(strip?.getAttribute('aria-label')).toMatch(/2/);
  });

  it('with no debrief applicable the games door is first and primary, and nothing offers a debrief', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const links = doorLinks(container);
    expect(links.map((a) => a.textContent)).toEqual(['See the 9 games', 'Open event']);
    const first = links[0]!;
    expect(first.closest('[data-slot="button"]')?.getAttribute('data-variant')).toBe('default');
    expect(first.getAttribute('href')).toMatch(/^\/match-data\?from=\d+&to=\d+#games$/);
    expect(links[1]!.getAttribute('href')).toBe('/tournaments/sn26');
    expect(screen.queryByText('Debrief this event')).toBeNull();
  });

  it('an event with no registry entry has the games door alone: no tier, no Open event', () => {
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games, { entry: null })), [
      ...games,
      ...older(400),
    ]);
    expect(doorLinks(container).map((a) => a.textContent)).toEqual(['See the 9 games']);
    expect(container.querySelector('[data-slot="tier-badge"]')).toBeNull();
    // Without placement the W-L sentence is used, under the event key.
    expect(screen.getByText('Supernova 2026 — 5–4 in games, 2–1 in sets.')).toBeInTheDocument();
  });

  it('a placement without entrants degrades to the W-L sentence', () => {
    const games = supernovaGames();
    const candidate = candidateOf(games, { entry: { numEntrants: undefined } });
    renderCard(recapOf(candidate), [...games, ...older(400)]);
    expect(screen.getByText('Supernova 2026 — 5–4 in games, 2–1 in sets.')).toBeInTheDocument();
  });

  it('dismisses through the recap result, one press', async () => {
    const dismiss = vi.fn();
    const games = supernovaGames();
    renderCard(recapOf(candidateOf(games), dismiss), [...games, ...older(400)]);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for none, and a labelled skeleton for loading', () => {
    const none = renderCard({ status: 'none', candidate: null, dismiss: vi.fn() }, []);
    expect(none.container.querySelector('[data-slot="recap-card"]')).toBeNull();
    cleanup();
    const loading = renderCard({ status: 'loading', candidate: null, dismiss: vi.fn() }, []);
    expect(loading.container.querySelector('[data-slot="recap-card"]')).toBeNull();
    expect(within(loading.container).getByRole('status')).toBeInTheDocument();
  });

  describe('the games door (same-n)', () => {
    const subjectPath = (p: string) => p;

    it('is the event window on Match Data when the window holds exactly the event', () => {
      const games = supernovaGames();
      const href = buildGamesDoorHref(games, [...games, ...older(10)], subjectPath);
      const times = games.map((g) => g.time);
      expect(href).toBe(`/match-data?from=${Math.min(...times)}&to=${Math.max(...times)}#games`);
    });

    it('is dropped when a stray game sits inside the window (the printed count would be wrong)', () => {
      const games = supernovaGames();
      const stray = { ...games[4]!, id: 'stray', eventName: undefined, tournamentName: undefined };
      expect(buildGamesDoorHref(games, [...games, stray], subjectPath)).toBeNull();
    });

    it('keeps the subject prefix, so a coach never lands on the viewer own games', () => {
      const games = supernovaGames();
      const { container } = renderCard(
        recapOf(candidateOf(games, { entry: null })),
        [...games, ...older(50)],
        '/coach/client-1/dashboard',
      );
      expect(doorLinks(container)[0]!.getAttribute('href')).toMatch(
        /^\/coach\/client-1\/match-data\?from=\d+&to=\d+#games$/,
      );
    });
  });
});

describe('the debrief door exists only when the debrief is really open (plan 39.2-13, D-11, D-18)', () => {
  const OPEN: PrepBriefStatus = { activated: true, reviewAt: Date.now() - 2 * DAY };

  function setPrep(state: 'open' | 'closed' | 'expired' | 'pending' | 'error') {
    if (state === 'open') {
      prepState = { isSuccess: true, isPending: false, data: OPEN };
    } else if (state === 'closed') {
      prepState = { isSuccess: true, isPending: false, data: { activated: false } };
    } else if (state === 'expired') {
      prepState = {
        isSuccess: true,
        isPending: false,
        data: { activated: true, reviewAt: Date.now() - 20 * DAY },
      };
    } else if (state === 'error') {
      prepState = { isSuccess: false, isPending: false, data: undefined };
    } else {
      prepState = { isSuccess: false, isPending: true, data: undefined };
    }
  }

  beforeEach(() => {
    usePrepBriefSpy.mockClear();
  });
  afterEach(cleanup);

  it('an open debrief makes "Debrief this event" the first, primary door, then the games door, then Open event', () => {
    setPrep('open');
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
    const links = doorLinks(container);
    expect(links.map((a) => a.textContent)).toEqual([
      'Debrief this event',
      'See the 9 games',
      'Open event',
    ]);
    expect(links[0]!.getAttribute('href')).toBe('/tournaments/sn26/prep');
    const variants = links.map((a) =>
      a.closest('[data-slot="button"]')?.getAttribute('data-variant'),
    );
    expect(variants).toEqual(['default', 'outline', 'outline']);
    expect(usePrepBriefSpy).toHaveBeenCalledWith('sn26');
  });

  it.each([
    ['not activated', 'closed'],
    ['past the fourteen-day debrief window', 'expired'],
    ['still pending (never a door the settled render retracts)', 'pending'],
    ['failed', 'error'],
  ] as const)(
    'no debrief door when the status is %s; the games door is primary',
    (_label, state) => {
      setPrep(state);
      const games = supernovaGames();
      const { container } = renderCard(recapOf(candidateOf(games)), [...games, ...older(400)]);
      expect(screen.queryByText('Debrief this event')).toBeNull();
      const links = doorLinks(container);
      expect(links[0]!.textContent).toBe('See the 9 games');
      expect(links[0]!.closest('[data-slot="button"]')?.getAttribute('data-variant')).toBe(
        'default',
      );
      // Nothing is a stand-in for the debrief: no link lands in prep mode.
      expect(links.some((a) => a.getAttribute('href')?.endsWith('/prep'))).toBe(false);
    },
  );

  it('an admin-imported entry never offers a debrief, even when the server status is open, and is never read', () => {
    setPrep('open');
    const games = supernovaGames();
    const { container } = renderCard(recapOf(candidateOf(games, { imported: true })), [
      ...games,
      ...older(400),
    ]);
    expect(screen.queryByText('Debrief this event')).toBeNull();
    expect(doorLinks(container)[0]!.textContent).toBe('See the 9 games');
    expect(usePrepBriefSpy).toHaveBeenCalledWith(undefined);
    expect(usePrepBriefSpy).not.toHaveBeenCalledWith('sn26');
  });

  it('a coach subject (no entry) has the door structurally absent, whatever the status', () => {
    setPrep('open');
    const games = supernovaGames();
    const { container } = renderCard(
      recapOf(candidateOf(games, { entry: null })),
      [...games, ...older(400)],
      '/coach/client-1/dashboard',
    );
    expect(screen.queryByText('Debrief this event')).toBeNull();
    expect(container.textContent).not.toMatch(/debrief/i);
    expect(doorLinks(container).map((a) => a.textContent)).toEqual(['See the 9 games']);
    expect(usePrepBriefSpy).not.toHaveBeenCalledWith('sn26');
    expect(usePrepBriefSpy.mock.calls.every(([key]) => key === undefined)).toBe(true);
  });
});

/**
 * G16 (UI-SPEC section 13, D-11, T-39.2-55): nothing paid is reachable from the recap. Three
 * independent proofs: the import graph, the rendered text of every state, and the absence of the
 * sparkle icon that marks a paid affordance elsewhere in the app.
 */
const SRC_ROOT = resolve('src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
/** The plan's two directories plus the paid modules that live outside them. */
const PAID_PATH =
  /\/(reports|billing|prepPaid)\/|\/(useBilling|usePrepPaidReports|useScoutReports)\.tsx?$/i;
/** Copied from `prepStructuralIntegrity.test.ts`; that file stays byte-unchanged. */
const MONETIZATION_VOCABULARY =
  /upgrade|unlock|paywall|pricing|price|checkout|stripe|coming soon|\$\d/i;

interface ModuleIo {
  read(path: string): string | undefined;
  isFile(path: string): boolean;
}

const nodeIo: ModuleIo = {
  read: (path) => readFileSync(path, 'utf8'),
  isFile: (path) => existsSync(path) && statSync(path).isFile(),
};

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveSpecifier(specifier: string, from: string, io: ModuleIo): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = resolve(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null; // a package import: the walk stops at the package boundary
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => resolve(base, `index${ext}`)),
  ];
  return candidates.find((candidate) => io.isFile(candidate)) ?? null;
}

/** Every module reachable from `entry` through relative and `@/` imports (the entry included). */
function reachableModules(entry: string, io: ModuleIo): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!SOURCE_EXTENSIONS.some((ext) => current.endsWith(ext))) continue;
    const source = io.read(current);
    if (source === undefined) continue;
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, current, io);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function paidModulesIn(modules: Set<string>): string[] {
  return [...modules].filter((path) => PAID_PATH.test(path));
}

/** An in-memory module graph, so the walker can be shown to catch a paid import. */
function virtualIo(files: Record<string, string>): ModuleIo {
  const absolute = new Map(
    Object.entries(files).map(([path, body]) => [resolve(SRC_ROOT, path), body]),
  );
  return {
    read: (path) => absolute.get(path),
    isFile: (path) => absolute.has(path),
  };
}

function visibleStrings(container: HTMLElement): string {
  const attributes = Array.from(container.querySelectorAll('[aria-label], [title]')).flatMap(
    (node) => [node.getAttribute('aria-label') ?? '', node.getAttribute('title') ?? ''],
  );
  return [container.textContent ?? '', ...attributes].join('\n');
}

describe('G16: nothing paid is reachable from the recap (plan 39.2-13, D-11, T-39.2-55)', () => {
  beforeEach(() => {
    prepState = {
      isSuccess: true,
      isPending: false,
      data: { activated: true, reviewAt: Date.now() - 2 * DAY },
    };
  });
  afterEach(cleanup);

  it('the import graph of RecapCard.tsx reaches no reports or billing module', () => {
    const entry = resolve(SRC_ROOT, 'components/analytics/track/RecapCard.tsx');
    const modules = reachableModules(entry, nodeIo);
    // Non-vacuous: the walk reached the modules the card really uses, through both kinds of specifier.
    const reached = [...modules].map((path) => path.slice(SRC_ROOT.length));
    expect(reached).toEqual(
      expect.arrayContaining([
        '/components/analytics/InsightCard.tsx',
        '/components/analytics/tier/TierBadge.tsx',
        '/hooks/usePrepBrief.ts',
        '/components/analytics/track/recapGamesDoor.ts',
      ]),
    );
    expect(modules.size).toBeGreaterThan(25);
    expect(paidModulesIn(modules)).toEqual([]);
  });

  it('the hook and gate the Dashboard mounts beside it reach none either', () => {
    for (const file of [
      'hooks/useRecapCandidate.ts',
      'components/analytics/track/RecapCandidateGate.tsx',
    ]) {
      expect(paidModulesIn(reachableModules(resolve(SRC_ROOT, file), nodeIo))).toEqual([]);
    }
  });

  it('negative control: the walker reports a synthetic graph that does reach a billing path', () => {
    const io = virtualIo({
      'card/Card.tsx': "import { helper } from './helper';\nexport const Card = helper;",
      'card/helper.ts':
        "import { Buy } from '@/components/billing/BuyCreditsDialog';\nexport const helper = Buy;",
      'components/billing/BuyCreditsDialog.tsx': 'export const Buy = 1;',
    });
    const found = paidModulesIn(reachableModules(resolve(SRC_ROOT, 'card/Card.tsx'), io));
    expect(found.map((path) => path.slice(SRC_ROOT.length))).toEqual([
      '/components/billing/BuyCreditsDialog.tsx',
    ]);
    // ... and a dynamic import or a re-export is followed just the same.
    const dynamic = virtualIo({
      'card/Card.tsx': "export const load = () => import('./lazy');",
      'card/lazy.ts': "export * from '../pages/Reports/ReportsPage';",
      'pages/Reports/ReportsPage.tsx': 'export const Page = 1;',
    });
    expect(
      paidModulesIn(reachableModules(resolve(SRC_ROOT, 'card/Card.tsx'), dynamic)),
    ).toHaveLength(1);
    // A clean graph reports nothing.
    const clean = virtualIo({
      'card/Card.tsx': "import './a';",
      'card/a.ts': 'export const a = 1;',
    });
    expect(paidModulesIn(reachableModules(resolve(SRC_ROOT, 'card/Card.tsx'), clean))).toEqual([]);
  });

  it('negative control: the monetization regex catches the vocabulary it is copied for', () => {
    for (const phrase of [
      'Upgrade now',
      'Unlock more',
      'Pricing',
      'Buy for $5',
      'Checkout',
      'Coming soon',
    ]) {
      expect(MONETIZATION_VOCABULARY.test(phrase)).toBe(true);
    }
    expect(MONETIZATION_VOCABULARY.test('Debrief this event')).toBe(false);
  });

  it('no state renders monetization vocabulary or a sparkle icon', async () => {
    const games = supernovaGames();
    const history = [...games, ...older(400)];
    const states: [string, RecapCandidateResult, Match[], string][] = [
      ['own-account, debrief open', recapOf(candidateOf(games)), history, '/dashboard'],
      [
        'own-account, imported',
        recapOf(candidateOf(games, { imported: true })),
        history,
        '/dashboard',
      ],
      ['no registry entry', recapOf(candidateOf(games, { entry: null })), history, '/dashboard'],
      [
        'coach subject',
        recapOf(candidateOf(games, { entry: null })),
        history,
        '/coach/client-1/dashboard',
      ],
      [
        'thin event',
        recapOf(candidateOf(games.slice(0, 5))),
        [...games.slice(0, 5), ...older(400)],
        '/dashboard',
      ],
      ['loading', { status: 'loading', candidate: null, dismiss: vi.fn() }, history, '/dashboard'],
    ];
    for (const [label, recap, matches, path] of states) {
      const { container, unmount } = renderCard(recap, matches, path);
      // Open the tier tooltip too, so its provenance text is part of what is scanned.
      const badge = container.querySelector('[data-slot="tier-badge"]');
      if (badge) await userEvent.hover(badge);
      const text = visibleStrings(document.body);
      expect(text, `state: ${label}`).not.toMatch(MONETIZATION_VOCABULARY);
      expect(
        document.body.querySelector('.lucide-sparkles, .lucide-sparkle'),
        `state: ${label}`,
      ).toBeNull();
      unmount();
      cleanup();
    }
  });

  it('a coach-subject render contains no debrief door text at all', () => {
    const games = supernovaGames();
    const { container } = renderCard(
      recapOf(candidateOf(games, { entry: null })),
      [...games, ...older(400)],
      '/coach/client-1/dashboard',
    );
    expect(within(container).queryByText('Debrief this event')).toBeNull();
  });
});
