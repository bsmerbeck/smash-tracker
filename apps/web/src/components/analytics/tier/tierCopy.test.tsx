import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  buildTierSplitStats,
  resolveTournamentTier,
  type Match,
  type TierEntryFields,
  type TierResolution,
  type TierSplitCoverage,
  type TierSplitEntry,
  type TierSplitStats,
} from '@smash-tracker/shared';
import i18n from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ByTierCard } from './ByTierCard';
import { TierBadge } from './TierBadge';
import { TierCoverageLine } from './TierCoverageLine';
import { TierInsightCard } from './TierInsightCard';
import { buildTierGapInsight } from './tierGapInsight';
import { TierProvenanceLine } from './TierProvenanceLine';
import { tierProvenanceKey, useTierProvenanceText } from './tierProvenance';

/**
 * G4, part 1 (UI-SPEC §13, CONTEXT lesson "copy-params render test"): every
 * basis / reason a tier can carry is rendered through the REAL six locale
 * files, and no interpolation placeholder may survive into the DOM, no raw
 * entry key may appear where a name belongs, and the estimated sentence must
 * show its grouped figure. A key whose translation drops or renames a
 * `{{token}}` would leave a literal placeholder behind and fail here.
 */

const LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ja'] as const;
const RAW_ENTRY_KEY = 'startgg-99001-1581';

const OFFLINE: TierEntryFields = { eventName: 'Supernova 2026', isOnline: false };

const CASES: { name: string; resolution: TierResolution }[] = [
  {
    name: 'estimated, many entrants',
    resolution: resolveTournamentTier({ entry: { ...OFFLINE, numEntrants: 1581 } }),
  },
  {
    name: 'estimated, one entrant',
    resolution: resolveTournamentTier({ entry: { ...OFFLINE, numEntrants: 1 } }),
  },
  {
    name: 'manual',
    resolution: resolveTournamentTier({
      entry: {
        ...OFFLINE,
        numEntrants: 412,
        tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
      },
    }),
  },
  {
    name: 'manual set to unknown',
    resolution: resolveTournamentTier({
      entry: {
        ...OFFLINE,
        numEntrants: 412,
        tierOverride: { contractVersion: 1, tier: 'unknown', setAtMs: 1 },
      },
    }),
  },
  {
    name: 'recorded on Liquipedia (typed for Phase 42)',
    resolution: resolveTournamentTier({
      entry: OFFLINE,
      externalTierRow: { tier: 'supermajor', source: 'liquipedia' },
    }),
  },
  {
    name: 'unknown, online',
    resolution: resolveTournamentTier({
      entry: { eventName: 'Weekly', isOnline: true, numEntrants: 5605 },
    }),
  },
  {
    name: 'unknown, side event',
    resolution: resolveTournamentTier({
      entry: { eventName: 'Squad Strike', isOnline: false, numEntrants: 300 },
    }),
  },
  {
    name: 'unknown, no entrant count',
    resolution: resolveTournamentTier({ entry: { eventName: 'Weekly', isOnline: false } }),
  },
  {
    name: 'unknown, setting unknown',
    resolution: resolveTournamentTier({ entry: { eventName: 'Weekly', numEntrants: 100 } }),
  },
];

function Probe({ resolution }: { resolution: TierResolution }) {
  const provenance = useTierProvenanceText(resolution) ?? '';
  return (
    <TooltipProvider>
      <TierBadge
        tier={resolution.tier}
        basis={resolution.basis}
        source={resolution.source}
        provenance={provenance}
      />
      <TierProvenanceLine resolution={resolution} />
    </TooltipProvider>
  );
}

describe('tier copy through the real locale files (G4)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('exercises every reason and basis the resolver can produce (non-vacuity)', () => {
    const bases = new Set(CASES.map((item) => item.resolution.basis));
    expect([...bases].sort()).toEqual(['estimated', 'manual', 'recorded', 'unknown']);
    const reasons = new Set(CASES.map((item) => item.resolution.reason));
    for (const reason of ['online', 'sideEvent', 'noEntrants', 'settingUnknown', 'manual']) {
      expect(reasons.has(reason as TierResolution['reason']), reason).toBe(true);
    }
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      for (const { name, resolution } of CASES) {
        it(`${name}: no placeholder survives and no raw entry key appears`, async () => {
          await i18n.changeLanguage(locale);
          const { container } = render(<Probe resolution={resolution} />);
          const text = container.textContent ?? '';
          expect(text).not.toContain('{{');
          expect(text).not.toContain('}}');
          expect(text).not.toContain(RAW_ENTRY_KEY);
          expect(text.trim()).not.toBe('');
          const line = container.querySelector('[data-slot="tier-provenance"]');
          // The recorded tier renders a Liquipedia sentence; every other case names its basis.
          expect(line, `${locale} ${name} renders a provenance line`).not.toBeNull();
          expect(line?.textContent?.trim()).not.toBe('');
        });
      }

      it('the estimated line carries the grouped entrant figure in this locale', async () => {
        await i18n.changeLanguage(locale);
        const estimated = CASES[0]!.resolution;
        const { container } = render(<Probe resolution={estimated} />);
        const line = container.querySelector('[data-slot="tier-provenance"]')?.textContent ?? '';
        const grouped = new Intl.NumberFormat(locale).format(1581);
        expect(line).toContain(grouped);
        if (locale === 'en') {
          expect(line).toBe('Estimated from 1,581 entrants');
        }
      });
    });
  }

  it('en: the singular and plural estimated sentences select their own form', async () => {
    await i18n.changeLanguage('en');
    const one = tierProvenanceKey(CASES[1]!.resolution, 'en');
    const many = tierProvenanceKey(CASES[0]!.resolution, 'en');
    expect(i18n.t(one!.key, one!.values)).toBe('Estimated from 1 entrant');
    expect(i18n.t(many!.key, many!.values)).toBe('Estimated from 1,581 entrants');
  });

  it('a tier badge never leaks the tier word key of another tier (the word is the localised label)', async () => {
    await i18n.changeLanguage('de');
    const { container } = render(<Probe resolution={CASES[0]!.resolution} />);
    expect(container.querySelector('[data-slot="tier-badge"]')?.textContent).toBe('Supermajor');
    await i18n.changeLanguage('ja');
    const { container: jaContainer } = render(<Probe resolution={CASES[0]!.resolution} />);
    expect(jaContainer.querySelector('[data-slot="tier-badge"]')?.textContent).toBe(
      'スーパーメジャー',
    );
  });
});

/**
 * G4, part 2 (UI-SPEC §13, plan 39.2-08): the By-tier card and the coverage
 * line through the SAME six real locale files. Every state the card can be in
 * is rendered from the real `buildTierSplitStats` output, and in each locale
 * no placeholder may survive and no raw tier id may stand where the localised
 * tier word belongs (in visible text or in an accessible name).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);
// `unknown` is left out: it is also an ordinary English word ("12 unknown"), so its raw id cannot be told apart from copy.
const RAW_TIER_IDS = ['supermajor', 'major', 'minor', 'regional', 'local'];

function splitEntry(index: number, overrides: Partial<TierSplitEntry> = {}): TierSplitEntry {
  return {
    entryKey: `copy-${index}`,
    eventName: `Copy Event ${index}`,
    tournamentName: `Copy Tournament ${index}`,
    firstSetAt: BASE + index * 30 * DAY_MS,
    lastSetAt: BASE + index * 30 * DAY_MS + DAY_MS / 2,
    isOnline: false,
    ...overrides,
  };
}

function gamesFor(target: TierSplitEntry, wins: number, losses: number, online = false): Match[] {
  return Array.from({ length: wins + losses }, (_, i) => ({
    id: `${target.entryKey}-${i}`,
    time: target.firstSetAt + i * 1000,
    win: i < wins,
    fighter_id: 1,
    opponent_id: 2,
    map: { id: 0, name: 'no selection' },
    opponent: '',
    notes: '',
    matchType: online ? 'online-tourney' : 'offline-tourney',
    eventName: target.eventName,
    tournamentName: target.tournamentName ?? undefined,
  })) as Match[];
}

interface CardCase {
  name: string;
  stats: TierSplitStats;
  sideEventCount: number;
  initialEntry?: string;
}

function cardCases(): CardCase[] {
  const supermajor = splitEntry(1, { numEntrants: 2048 });
  const minor = splitEntry(2, { numEntrants: 300 });
  const minorEmpty = splitEntry(3, { numEntrants: 300 });
  const local = splitEntry(4, { numEntrants: 20 });
  const onlineA = splitEntry(5, { isOnline: true, numEntrants: 40 });
  const onlineB = splitEntry(6, { isOnline: true, numEntrants: 44 });
  const side = splitEntry(7, { eventName: 'Squad Strike', numEntrants: 300 });
  const manual = splitEntry(8, {
    numEntrants: 20,
    tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
  });

  const populated = [supermajor, minor, local, onlineA, onlineB, side];
  const populatedGames = [
    ...gamesFor(supermajor, 26, 7),
    ...gamesFor(minor, 1, 0),
    ...gamesFor(local, 8, 2),
    ...gamesFor(onlineA, 5, 5, true),
    ...gamesFor(side, 2, 1),
  ];
  return [
    {
      name: 'populated (rate bars, an abstaining tier, Unknown inset, three side events excluded)',
      stats: buildTierSplitStats({
        entries: populated,
        matches: populatedGames,
        includeSideEvents: false,
      }),
      sideEventCount: 3,
    },
    {
      name: 'abstaining, singular need (2 games)',
      stats: buildTierSplitStats({
        entries: [minor],
        matches: gamesFor(minor, 1, 1),
        includeSideEvents: false,
      }),
      sideEventCount: 1,
    },
    {
      name: 'abstaining, plural need (no linked games)',
      stats: buildTierSplitStats({
        entries: [minorEmpty],
        matches: [],
        includeSideEvents: false,
      }),
      sideEventCount: 0,
    },
    {
      name: 'all-unknown',
      stats: buildTierSplitStats({
        entries: [onlineA, onlineB],
        matches: gamesFor(onlineA, 4, 2, true),
        includeSideEvents: false,
      }),
      sideEventCount: 0,
    },
    {
      name: 'side events included',
      stats: buildTierSplitStats({
        entries: populated,
        matches: populatedGames,
        includeSideEvents: true,
      }),
      sideEventCount: 1,
      initialEntry: '/tournaments?side=include',
    },
    {
      name: 'a hand-set tier (the manual coverage token)',
      stats: buildTierSplitStats({
        entries: [manual],
        matches: gamesFor(manual, 3, 1),
        includeSideEvents: false,
      }),
      sideEventCount: 0,
    },
  ];
}

/** Every visible string and accessible name in a container, joined, with hrefs deliberately left out. */
function visibleAndNamedText(container: HTMLElement): string {
  const names = Array.from(container.querySelectorAll('[aria-label]')).map(
    (node) => node.getAttribute('aria-label') ?? '',
  );
  return [container.textContent ?? '', ...names].join('\n');
}

function isolatedRawIds(text: string): string[] {
  // A raw id is a lowercase whole word; the localised words are capitalised, so this never matches them.
  return RAW_TIER_IDS.filter((id) => new RegExp(`(^|[^\\p{L}])${id}([^\\p{L}]|$)`, 'u').test(text));
}

describe('by-tier copy through the real locale files (G4, plan 39.2-08)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('exercises every state of the card (non-vacuity)', () => {
    const cases = cardCases();
    expect(cases.some((c) => c.stats.rows.some((row) => row.rate != null))).toBe(true);
    expect(cases.some((c) => c.stats.rows.some((row) => row.rate == null))).toBe(true);
    expect(cases.some((c) => c.stats.rows.length === 0 && c.stats.unknown != null)).toBe(true);
    expect(cases.some((c) => c.stats.coverage.manual > 0)).toBe(true);
    expect(cases.some((c) => c.initialEntry?.includes('side=include'))).toBe(true);
    expect(new Set(cases.map((c) => c.sideEventCount)).size).toBeGreaterThan(2);
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      for (const item of cardCases()) {
        it(`${item.name}: no placeholder survives and no raw tier id stands where a word belongs`, async () => {
          await i18n.changeLanguage(locale);
          const { container } = render(
            <MemoryRouter initialEntries={[item.initialEntry ?? '/tournaments']}>
              <ByTierCard
                stats={item.stats}
                sideEventCount={item.sideEventCount}
                overallRate={0.6}
              />
            </MemoryRouter>,
          );
          const text = visibleAndNamedText(container);
          expect(text).not.toContain('{{');
          expect(text).not.toContain('}}');
          expect(isolatedRawIds(text), `${locale}: raw tier id in copy`).toEqual([]);
          expect(container.querySelector('h2')?.textContent?.trim()).toBeTruthy();
          // The coverage line is always present and always non-empty.
          expect(
            container.querySelector('[data-slot="tier-coverage"]')?.textContent?.trim(),
          ).toBeTruthy();
        });
      }

      it('the coverage line groups large counts in this locale and keeps every token', async () => {
        await i18n.changeLanguage(locale);
        const coverage: TierSplitCoverage = {
          total: 1300,
          known: 1234,
          recorded: 1000,
          manual: 34,
          estimated: 200,
          unknown: 66,
          sideExcluded: 0,
        };
        const { container } = render(<TierCoverageLine coverage={coverage} />);
        const text = container.textContent ?? '';
        const grouped = new Intl.NumberFormat(locale).format(1234);
        expect(text).toContain(grouped);
        expect(text).not.toContain('{{');
        expect(container.querySelectorAll('[data-token]')).toHaveLength(5);
      });

      it('the singular and plural coverage tokens both resolve (no missing-key echo)', async () => {
        await i18n.changeLanguage(locale);
        for (const count of [0, 1, 2]) {
          const coverage: TierSplitCoverage = {
            total: count,
            known: count,
            recorded: count,
            manual: 0,
            estimated: 0,
            unknown: count,
            sideExcluded: 0,
          };
          const { container, unmount } = render(<TierCoverageLine coverage={coverage} />);
          expect(container.textContent).not.toContain('tiers.coverage');
          expect(container.textContent).not.toContain('{{');
          unmount();
        }
      });
    });
  }

  it('en: the coverage line reads exactly as the spec words it, zero values kept', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(
      <TierCoverageLine
        coverage={{
          total: 19,
          known: 7,
          recorded: 0,
          manual: 0,
          estimated: 7,
          unknown: 12,
          sideExcluded: 0,
        }}
      />,
    );
    expect(container.textContent).toBe(
      'Tier known for 7 of 19 events · 0 recorded · 7 estimated · 12 unknown',
    );
  });

  it('a guard that can fail: a raw tier id standing where a word belongs is detected', () => {
    expect(isolatedRawIds('Regional: 3–1')).toEqual([]);
    expect(isolatedRawIds('supermajor: 3–1, 4 games')).toEqual(['supermajor']);
    expect(isolatedRawIds('Tier=major')).toEqual(['major']);
  });
});

/**
 * G4, part 3 (UI-SPEC 13, plan 39.2-09): every `tierGap` state, rendered by the
 * real card from the real template over the real cohorts, through the SAME six
 * locale files. No placeholder may survive, no missing-key echo may appear, no
 * raw tier id may stand where a localised word belongs, and a param the
 * template failed to set on a state would leave a literal `{{param}}` behind.
 */
describe('tier insight copy through the real locale files (G4, plan 39.2-09)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  interface InsightCase {
    name: string;
    state: string;
    key: string;
    stats: TierSplitStats;
    matches: Match[];
    includeSideEvents?: boolean;
  }

  function insightCases(): InsightCase[] {
    const big = splitEntry(11, { numEntrants: 2048 });
    const local = splitEntry(12, { numEntrants: 20 });
    const manualBig = splitEntry(13, {
      numEntrants: 2048,
      tierOverride: { contractVersion: 1, tier: 'supermajor', setAtMs: 1 },
    });
    const manualLocal = splitEntry(14, {
      numEntrants: 20,
      tierOverride: { contractVersion: 1, tier: 'local', setAtMs: 1 },
    });
    const unknown = splitEntry(15);
    const side = splitEntry(16, {
      eventName: 'Squad Strike',
      numEntrants: 300,
      tierOverride: { contractVersion: 1, tier: 'major', setAtMs: 1 },
    });

    const make = (
      entries: TierSplitEntry[],
      matches: Match[],
      includeSideEvents = false,
    ): { stats: TierSplitStats; matches: Match[]; includeSideEvents: boolean } => ({
      stats: buildTierSplitStats({ entries, matches, includeSideEvents }),
      matches,
      includeSideEvents,
    });

    return [
      {
        name: 'up (a large grouped cohort, both events estimated)',
        state: 'trend',
        key: 'insights.tierGap.up',
        ...make([big, local], [...gamesFor(big, 1000, 234), ...gamesFor(local, 4, 8)]),
      },
      {
        name: 'down',
        state: 'trend',
        key: 'insights.tierGap.down',
        ...make([big, local], [...gamesFor(big, 4, 8), ...gamesFor(local, 26, 7)]),
      },
      {
        name: 'steady',
        state: 'steady',
        key: 'insights.tierGap.steady',
        ...make([big, local], [...gamesFor(big, 17, 16), ...gamesFor(local, 6, 6)]),
      },
      {
        name: 'abstained (majors short)',
        state: 'locked',
        key: 'insights.tierGap.abstained',
        ...make([big, local], [...gamesFor(big, 3, 2), ...gamesFor(local, 4, 8)]),
      },
      {
        name: 'abstained (smaller events short)',
        state: 'locked',
        key: 'insights.tierGap.abstainedSmaller',
        ...make([big, local], [...gamesFor(big, 26, 7), ...gamesFor(local, 1, 2)]),
      },
      {
        name: 'noTiers',
        state: 'thin',
        key: 'insights.tierGap.noTiers',
        ...make([unknown], gamesFor(unknown, 4, 4)),
      },
      {
        name: 'no estimated event (the sub line is absent)',
        state: 'trend',
        key: 'insights.tierGap.up',
        ...make(
          [manualBig, manualLocal],
          [...gamesFor(manualBig, 26, 7), ...gamesFor(manualLocal, 4, 8)],
        ),
      },
      {
        name: 'side events included',
        state: 'trend',
        key: 'insights.tierGap.up',
        ...make(
          [big, local, side],
          [...gamesFor(big, 26, 7), ...gamesFor(local, 4, 8), ...gamesFor(side, 6, 0)],
          true,
        ),
      },
    ];
  }

  function renderInsight(item: InsightCase) {
    const insight = buildTierGapInsight({
      stats: item.stats,
      matches: item.matches,
      includeSideEvents: item.includeSideEvents ?? false,
      nowMs: BASE + 400 * DAY_MS,
    })!;
    return {
      insight,
      ...render(
        <MemoryRouter initialEntries={['/tournaments']}>
          <TierInsightCard
            insight={insight}
            coverage={item.stats.coverage}
            onDismiss={() => undefined}
          />
        </MemoryRouter>,
      ),
    };
  }

  it('exercises every tierGap state and both cohort short-sides (non-vacuity)', () => {
    const cases = insightCases();
    const keys = new Set(cases.map((item) => item.key));
    for (const key of ['up', 'down', 'steady', 'abstained', 'abstainedSmaller', 'noTiers']) {
      expect(keys.has(`insights.tierGap.${key}`), key).toBe(true);
    }
    for (const item of cases) {
      const insight = buildTierGapInsight({
        stats: item.stats,
        matches: item.matches,
        includeSideEvents: item.includeSideEvents ?? false,
        nowMs: BASE + 400 * DAY_MS,
      });
      expect(insight?.copy.key, item.name).toBe(item.key);
      expect(insight?.state, item.name).toBe(item.state);
    }
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      for (const item of insightCases()) {
        it(`${item.name}: no placeholder, no missing-key echo, no raw tier id`, async () => {
          await i18n.changeLanguage(locale);
          const { container, insight } = renderInsight(item);
          const text = visibleAndNamedText(container);
          expect(text).not.toContain('{{');
          expect(text).not.toContain('}}');
          expect(text).not.toContain('insights.tierGap');
          expect(text).not.toContain('insights.door');
          expect(isolatedRawIds(text), `${locale}: raw tier id in copy`).toEqual([]);
          // The verdict states the state's own sentence, never the English fallback in another locale.
          const verdict = i18n.t(insight.copy.key, insight.copy.values);
          expect(verdict.trim()).not.toBe('');
          expect(container.textContent).toContain(verdict);
          if (locale !== 'en') {
            expect(verdict).not.toBe(
              i18n.t(insight.copy.key, { ...insight.copy.values, lng: 'en' }),
            );
          }
        });
      }

      it('a large cohort is grouped in this locale and the estimated note names its count', async () => {
        await i18n.changeLanguage(locale);
        const [up] = insightCases();
        const { container } = renderInsight(up!);
        const grouped = new Intl.NumberFormat(locale).format(1234);
        expect(container.textContent).toContain(grouped);
        const note = container.querySelector('[data-slot="insight-card-sub"]')?.textContent ?? '';
        expect(note).toContain('2');
        expect(note).not.toContain('{{');
      });
    });
  }

  it('en: the verdicts read exactly as the spec words them', async () => {
    await i18n.changeLanguage('en');
    const byKey = new Map(insightCases().map((item) => [item.name, item] as const));
    const verdictOf = (name: string): string => {
      const item = byKey.get(name)!;
      const insight = buildTierGapInsight({
        stats: item.stats,
        matches: item.matches,
        includeSideEvents: item.includeSideEvents ?? false,
        nowMs: BASE + 400 * DAY_MS,
      })!;
      return i18n.t(insight.copy.key, insight.copy.values);
    };
    expect(verdictOf('down')).toBe('Majors and above — 33% over 12, below 79% at smaller events.');
    expect(verdictOf('abstained (majors short)')).toBe('Not enough games at majors (5).');
    expect(verdictOf('abstained (smaller events short)')).toBe(
      'Not enough games at smaller events (3).',
    );
    expect(verdictOf('noTiers')).toBe('Tier — no event has a known tier yet.');
  });

  it('a guard that can fail: a template that omits a param leaves a placeholder the render check catches', async () => {
    await i18n.changeLanguage('en');
    const rendered = i18n.t('insights.tierGap.up', { aRate: '80%', bRate: '30%' });
    expect(rendered.includes('{{') || rendered.includes('undefined')).toBe(true);
  });
});
