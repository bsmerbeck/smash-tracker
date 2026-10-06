import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 41 plan 41-01 (I18N-01): the committed, falsifiable oracle for the Phase 41 copy ledger.
 * Every key below ships in all six locales in this plan so plans 41-02..41-11 only READ them (the
 * locale JSONs are the phase's merge hotspot). For each locale file read from disk it asserts:
 * (a) the key resolves to a non-empty string; (b) its `{{name, format}}` token set equals en's;
 * (c) every `_one` key has its `_other` sibling and vice versa; (d) the ledger is not vacuous.
 * i18n.test.ts already pins whole-file key-set parity; this test names the Phase 41 keys so a missing
 * or mistyped one fails with the key in the message.
 */

const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');
const LOCALE_CODES = ['en', 'es', 'fr', 'de', 'pt', 'ja'] as const;

/** Every dotted Phase 41 key, expanded — no wildcards, so a deleted key cannot hide behind a prefix. */
export const PHASE41_LEDGER_KEYS: readonly string[] = [
  'dashboard.formStrip.title.last30',
  'dashboard.formStrip.title.lastEvent',
  'dashboard.formStrip.title.last90',
  'dashboard.formStrip.sets_one',
  'dashboard.formStrip.sets_other',
  'dashboard.formStrip.empty',
  'dashboard.formStrip.windowEmpty.lastEvent',
  'dashboard.formStrip.windowEmpty.last90',
  'analytics.valueTrend.aria_one',
  'analytics.valueTrend.aria_other',
  'analytics.valueTrend.legend.calibration',
  'analytics.valueTrend.legend.reference',
  'analytics.valueTrend.legend.referenceAbove',
  'analytics.valueTrend.legend.referenceBelow',
  'analytics.valueTrend.readings_one',
  'analytics.valueTrend.readings_other',
  'analytics.valueTrend.table.headers.date',
  'analytics.valueTrend.table.headers.readings',
  'analytics.valueTrend.lockedMeter',
  'analytics.multiples.aria_one',
  'analytics.multiples.aria_other',
  'analytics.multiples.caption',
  'analytics.heat.legend.fewer',
  'analytics.heat.legend.more',
  'analytics.heat.legend.unit',
  'analytics.heat.cellAria_one',
  'analytics.heat.cellAria_other',
  'analytics.heat.noGames',
  'analytics.heat.table.caption',
  'trends.rhythm.title',
  'trends.rhythm.caption.years_one',
  'trends.rhythm.caption.years_other',
  'trends.rhythm.caption.shownOf',
  'insights.playRhythm.fact.compare',
  'insights.playRhythm.fact.compareNoSeason',
  'insights.playRhythm.fact.recentOnly',
  'insights.playRhythm.evidence',
  'insights.playRhythm.evidenceNoSeason',
  'insights.playRhythm.locked_one',
  'insights.playRhythm.locked_other',
  'insights.playRhythm.lockedMeter',
  'analytics.timeline.event.legend_one',
  'analytics.timeline.event.legend_other',
  'analytics.timeline.event.legendEstimated',
  'analytics.timeline.event.shownOf',
  'analytics.timeline.event.tierLine',
  'analytics.timeline.event.ariaEstimated',
  'analytics.timeline.event.ariaNoRating',
  'analytics.timeline.event.ariaEstimatedNoRating',
  'trends.recentEvents.outsideRange_one',
  'trends.recentEvents.outsideRange_other',
  'trends.recentEvents.allTime',
  'trends.recentEvents.backToRange',
  'trends.recentEvents.allTimeNote',
  'gsp.hero.latestReadingDated',
  'gsp.hero.eliteValue',
  'gsp.hero.atElite',
  'gsp.hero.mmrUnit',
  'gsp.vsGlicko.noReading',
  'gsp.curve.view',
  'gsp.curve.overline.reading',
  'gsp.curve.overline.day',
  'gsp.curve.overline.week',
  'gsp.curve.overline.month',
  'gsp.curve.overline.quarter',
  'gsp.curve.overlineMmr.reading',
  'gsp.curve.overlineMmr.day',
  'gsp.curve.overlineMmr.week',
  'gsp.curve.overlineMmr.month',
  'gsp.curve.overlineMmr.quarter',
  'gsp.curve.legend.gsp',
  'gsp.curve.legend.mmr',
  'gsp.curve.legend.elite',
  'gsp.curve.legend.eliteMmr',
  'gsp.curve.readout.gsp',
  'gsp.curve.readout.mmr',
  'gsp.curve.clickHintPeriod',
  'gsp.curve.lockedMeter',
  'gsp.gains.figure.avgGain',
  'gsp.gains.figure.avgDrop',
  'gsp.gains.figure.biggestGain',
  'gsp.gains.figure.biggestDrop',
  'gsp.gains.figure.recentWins_one',
  'gsp.gains.figure.recentWins_other',
  'gsp.gains.figure.recentLosses_one',
  'gsp.gains.figure.recentLosses_other',
  'gsp.gains.byBand.title',
  'gsp.gains.byBand.caption',
  'gsp.gains.byBand.rowAria_one',
  'gsp.gains.byBand.rowAria_other',
  'gsp.gains.byBand.subFloor_one',
  'gsp.gains.byBand.subFloor_other',
  'gsp.gains.byBand.range',
  'gsp.vsGlicko.panel.mmr',
  'gsp.vsGlicko.panel.glicko',
  'gsp.vsGlicko.overline.reading',
  'gsp.vsGlicko.overline.day',
  'gsp.vsGlicko.overline.week',
  'gsp.vsGlicko.overline.month',
  'gsp.vsGlicko.overline.quarter',
  'gsp.vsGlicko.readout.mmr',
  'gsp.vsGlicko.readout.glicko',
  'gsp.vsGlicko.captionPanels',
  // Plan 41-12: the Scout Recent Form card's event-anchored caption (one per grain) and in-card games panel.
  'scout.fullAnalysis.form.caption.event',
  'scout.fullAnalysis.form.caption.week',
  'scout.fullAnalysis.form.caption.month',
  'scout.fullAnalysis.form.caption.quarter',
  'scout.fullAnalysis.form.caption.year',
  'scout.fullAnalysis.form.games_one',
  'scout.fullAnalysis.form.games_other',
  'scout.fullAnalysis.form.characters',
  'scout.fullAnalysis.form.close',
];

/**
 * Plan 41-11 (12.8 / I18N-01): every key a Phase 41 chart replacement retired. A key whose chart is gone
 * is dead copy in six languages; this list is the committed record that it STAYS gone. `dashboard.formCurve`
 * is a whole subtree (the chart.js Form Curve card, replaced by `dashboard.formStrip.*` in plan 41-10), so it
 * is listed as a namespace; every other entry is a single leaf. The conditional entries (`gsp.hero.elite`,
 * `gsp.hero.latestReading`, `gsp.curve.gspViewAria`, `gsp.curve.mmrViewAria`) were deleted because
 * `git grep` found no source reference to them in plan 41-11.
 */
export const PHASE41_DELETED_NAMESPACES: readonly string[] = ['dashboard.formCurve'];
export const PHASE41_DELETED_KEYS: readonly string[] = [
  ...PHASE41_DELETED_NAMESPACES,
  'gsp.gains.avgGainLifetime',
  'gsp.gains.avgDropLifetime',
  'gsp.gains.biggestGain',
  'gsp.gains.avgGainLast20',
  'gsp.gains.avgDropLast20',
  'gsp.gains.biggestDrop',
  'gsp.gains.perWinTitle',
  'gsp.gains.shrinking',
  'gsp.gains.growing',
  'gsp.gains.winNumber',
  'gsp.gains.gainedGsp',
  'gsp.vsGlicko.mmrLabel',
  'gsp.vsGlicko.glickoLabel',
  'gsp.vsGlicko.caption',
  'gsp.curve.eliteLine',
  'gsp.curve.eliteMmrLine',
  'gsp.curve.gspViewAria',
  'gsp.curve.mmrViewAria',
  'gsp.hero.elite',
  'gsp.hero.latestReading',
];

type LocaleTree = Record<string, unknown>;

function readLocale(code: string): LocaleTree {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) as LocaleTree;
}

function resolveKey(tree: LocaleTree, dotted: string): unknown {
  let node: unknown = tree;
  for (const part of dotted.split('.')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return node;
}

/** The sorted set of interpolation tokens (name plus format suffix) a string carries. */
function tokensOf(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map((m) => m[1]!.replace(/\s+/g, ' '))
    .sort();
}

const locales: Record<string, LocaleTree> = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, readLocale(code)]),
);

describe('Phase 41 copy ledger (I18N-01)', () => {
  it('is not vacuous: the ledger carries at least 95 keys', () => {
    expect(PHASE41_LEDGER_KEYS.length).toBeGreaterThanOrEqual(95);
    expect(new Set(PHASE41_LEDGER_KEYS).size).toBe(PHASE41_LEDGER_KEYS.length);
  });

  describe.each(LOCALE_CODES)('%s', (code) => {
    it('has every ledger key as a non-empty string', () => {
      const missing = PHASE41_LEDGER_KEYS.filter((key) => {
        const value = resolveKey(locales[code]!, key);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing, `${code}: missing or empty ledger keys`).toEqual([]);
    });

    it('carries the same {{token}} names as en for every ledger key', () => {
      const drifted: string[] = [];
      for (const key of PHASE41_LEDGER_KEYS) {
        const en = resolveKey(locales.en!, key);
        const own = resolveKey(locales[code]!, key);
        if (typeof en !== 'string' || typeof own !== 'string') continue;
        if (JSON.stringify(tokensOf(en)) !== JSON.stringify(tokensOf(own))) {
          drifted.push(
            `${key}: en=${JSON.stringify(tokensOf(en))} ${code}=${JSON.stringify(tokensOf(own))}`,
          );
        }
      }
      expect(drifted, `${code}: token drift vs en`).toEqual([]);
    });

    it('pairs every _one key with its _other sibling and vice versa', () => {
      const keys = new Set(PHASE41_LEDGER_KEYS);
      const unpaired = PHASE41_LEDGER_KEYS.filter((key) => {
        if (key.endsWith('_one')) return !keys.has(key.replace(/_one$/, '_other'));
        if (key.endsWith('_other')) return !keys.has(key.replace(/_other$/, '_one'));
        return false;
      });
      expect(unpaired, 'ledger plural pairs').toEqual([]);
      for (const key of PHASE41_LEDGER_KEYS.filter((k) => k.endsWith('_one'))) {
        const other = resolveKey(locales[code]!, key.replace(/_one$/, '_other'));
        expect(typeof other, `${code}: ${key} has no _other sibling`).toBe('string');
      }
    });
  });
});

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listNonTestSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listNonTestSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The dotted key as a whole key reference: not the prefix of a longer word (`gsp.hero.eliteValue`). */
function referencesKey(source: string, key: string): boolean {
  return new RegExp(`${key.replace(/\./g, '\\.')}(?!\\w)`).test(source);
}

describe('Phase 41 deleted keys stay deleted (plan 41-11, 12.8 / I18N-01)', () => {
  it('is not vacuous: the deleted list is non-empty, unique and names the formCurve namespace', () => {
    expect(PHASE41_DELETED_KEYS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PHASE41_DELETED_KEYS).size).toBe(PHASE41_DELETED_KEYS.length);
    expect(PHASE41_DELETED_KEYS).toContain('dashboard.formCurve');
  });

  it('the reference scanner matches a whole key and namespace children but never a longer sibling key', () => {
    expect(referencesKey("t('gsp.hero.elite')", 'gsp.hero.elite')).toBe(true);
    expect(referencesKey("t('gsp.hero.eliteValue')", 'gsp.hero.elite')).toBe(false);
    expect(referencesKey("t('gsp.hero.latestReadingDated')", 'gsp.hero.latestReading')).toBe(false);
    expect(referencesKey("t('dashboard.formCurve.title')", 'dashboard.formCurve')).toBe(true);
  });

  it('the ledger keys and the deleted keys are disjoint (no ledger key is retired or lives under a retired namespace)', () => {
    const overlap = PHASE41_LEDGER_KEYS.filter((key) =>
      PHASE41_DELETED_KEYS.some((gone) => key === gone || key.startsWith(`${gone}.`)),
    );
    expect(overlap).toEqual([]);
  });

  describe.each(LOCALE_CODES)('%s', (code) => {
    it('resolves none of the deleted keys', () => {
      const surviving = PHASE41_DELETED_KEYS.filter(
        (key) => resolveKey(locales[code]!, key) !== undefined,
      );
      expect(surviving, `${code}: deleted keys still present`).toEqual([]);
    });
  });

  it('no non-test source file under apps/web/src references a deleted key', () => {
    const files = listNonTestSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const key of PHASE41_DELETED_KEYS) {
        if (referencesKey(source, key)) {
          offenders.push(`${path.relative(SRC_ROOT, file).split(path.sep).join('/')}: ${key}`);
        }
      }
    }
    expect(offenders, `source files referencing a deleted key: ${offenders.join('; ')}`).toEqual(
      [],
    );
  });
});
