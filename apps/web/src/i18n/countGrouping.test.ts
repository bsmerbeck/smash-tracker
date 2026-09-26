import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';

/**
 * Plan 39.1-51, orchestrator addition OOS-40-B (39.1-40 whole-page review):
 * game counts of 1,000 or more printed ungrouped in insight copy ('See the 1425
 * games' on the recent Trends fixture, 'over 4237' / 'high confidence, 4237
 * games' on career). UI-SPEC §5: "Thousands separators through
 * `Intl.NumberFormat(i18n.language)`". The fix is i18next's built-in `number`
 * formatter in the interpolation (`{{count, number}}`), which formats with
 * `Intl.NumberFormat(<language>)` — so each locale groups its own way (en
 * 1,425 · de 1.425 · fr 1 425 · ja 1,425; es keeps 4-digit counts whole, per
 * CLDR's two-digit minimum grouping).
 */

const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

/** Insight-copy namespaces: the insight templates and the shared evidence cues they carry. */
const INSIGHT_COPY_ROOTS = ['insights', 'shared.evidence'];

/** Placeholders that carry a game count (engine `copy.values` and door counts — always numbers). */
const COUNT_PLACEHOLDERS = [
  'count',
  'baselineGames',
  'games',
  'spotCount',
  'pocketGames',
  'opponentGames',
  'totalLosses',
  'have',
  'need',
];

function readLocale(code: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

function stringsUnder(tree: Record<string, unknown>, root: string): [string, string][] {
  let node: unknown = tree;
  for (const part of root.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  const out: [string, string][] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string') out.push([key, value]);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${key}.${k}`);
    }
  };
  walk(node, root);
  return out;
}

describe('OOS-40-B: insight-copy counts are grouped per locale (plan 39.1-51)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('en: a door label groups a 4-digit count ("See the 1,425 games")', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('insights.door.seeGames', { count: 1425 })).toBe('See the 1,425 games');
  });

  it('en: the two-horizon evidence line and the sample cue group the all-time count ("over 4,237", "4,237 games")', async () => {
    await i18n.changeLanguage('en');
    expect(
      i18n.t('insights.evidence.twoHorizon.last30', {
        recentRecord: '18–12',
        baselineRate: '52%',
        baselineGames: 4237,
        cue: 'high confidence, 4,237 games',
      }),
    ).toBe('18–12 last 30 · 52% all time over 4,237 · high confidence, 4,237 games');
    expect(i18n.t('shared.evidence.sampleCueGlyph.high', { count: 4237 })).toBe(
      'high confidence, 4,237 games',
    );
  });

  it('de: the same door label groups with a dot ("1.425")', async () => {
    await i18n.changeLanguage('de');
    expect(i18n.t('insights.door.seeGames', { count: 1425 })).toBe('Die 1.425 Matches ansehen');
    expect(i18n.t('shared.evidence.sampleCueGlyph.high', { count: 4237 })).toBe(
      'hohe Konfidenz, 4.237 Matches',
    );
  });

  it('fr and ja group with their own separators; counts under 1,000 are unchanged', async () => {
    await i18n.changeLanguage('fr');
    expect(i18n.t('insights.door.seeGames', { count: 1425 })).toBe(
      `Voir les ${new Intl.NumberFormat('fr').format(1425)} matchs`,
    );
    await i18n.changeLanguage('ja');
    expect(i18n.t('insights.door.seeGames', { count: 1425 })).toBe('1,425試合を見る');
    await i18n.changeLanguage('en');
    expect(i18n.t('insights.door.seeGames', { count: 236 })).toBe('See the 236 games');
    expect(i18n.t('insights.door.seeGames', { count: 1 })).toBe('See the 1 game');
  });

  it('every insight-copy string in all six locales formats its count placeholders with the number formatter', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(6);
    const unformatted: string[] = [];
    let scanned = 0;
    for (const { code } of SUPPORTED_LANGUAGES) {
      const tree = readLocale(code);
      for (const root of INSIGHT_COPY_ROOTS) {
        for (const [key, value] of stringsUnder(tree, root)) {
          for (const match of value.matchAll(/\{\{\s*([A-Za-z]+)\s*(,[^}]*)?\}\}/g)) {
            if (!COUNT_PLACEHOLDERS.includes(match[1]!)) continue;
            scanned += 1;
            if (!/^,\s*number\s*$/.test(match[2] ?? ''))
              unformatted.push(`${code}:${key}:${match[0]}`);
          }
        }
      }
    }
    expect(scanned, 'non-vacuity: count placeholders scanned').toBeGreaterThan(300);
    expect(unformatted).toEqual([]);
  });
});
