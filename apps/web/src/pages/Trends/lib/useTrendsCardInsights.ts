import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import { ACCOUNT_SCOPE, INSIGHT_TEMPLATES } from '@smash-tracker/shared';
import { formatMonthName } from '@/lib/format';
import { formatPercent } from '@/lib/formatPercent';

/**
 * Plan 39.1-27 (gap closure, SC4/INS-04): the three card-level templates
 * `SettingComparison`/`MatchTypeMix` used to build locally, looked up by id
 * from the closed registry — mirrors `useFighterFormNow.ts`'s
 * `FORM_NOW_TEMPLATE` lookup precedent.
 */
const SETTING_GAP_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'settingGap')!;
const MIX_SHIFT_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'mixShift')!;
const VOLUME_FORM_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'volumeForm')!;
/**
 * Plan 41-03 (DD-41-07, RESEARCH correction 12): `playRhythm` is built HERE, in the card path, and
 * never in `useTrendsInsights` — so it can never rank as a reads-rail own read nor back-fill the
 * centre rail; it owns its own 4-col cell in Trends' row 4.
 */
const PLAY_RHYTHM_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'playRhythm')!;

export interface UseTrendsCardInsightsInput {
  matches: Match[];
  horizon: HorizonKey;
}

export interface UseTrendsCardInsightsResult {
  settingGap: Insight | null;
  mixShift: Insight | null;
  volumeForm: Insight | null;
  playRhythm: Insight | null;
}

/**
 * WR-C03 (39.1-REVIEW.md) precedent: a template crash must not silently
 * drop its card with zero signal — `template.id` carries no user
 * identifiers, only the closed template-registry id.
 */
function buildOne(
  template: (typeof INSIGHT_TEMPLATES)[number],
  matches: Match[],
  horizon: HorizonKey,
  nowMs: number,
): Insight | null {
  try {
    return template.build({ matches, scope: ACCOUNT_SCOPE, horizon, nowMs })[0] ?? null;
  } catch (err) {
    console.error('[trends-card-insight] template failed', template.id, err);
    return null;
  }
}

/**
 * Plan 39.1-27 (gap closure): the ONE computation of `settingGap`/`mixShift`/
 * `volumeForm`/`playRhythm` — `TrendsPage.tsx` calls this ONCE, above every early return,
 * and hands the result down to `SettingComparison`/`MatchTypeMix` as props
 * AND its own page-level terminus (`pageInsights`/`resolveClaim`/
 * `claimSummary`), so a rendered door's `claim=<id>` and the resolved list
 * are the same object's `countedMatchIds` — never a second, independently
 * built copy. Lives in a non-component `.ts` module on purpose, so it adds
 * no `react-refresh/only-export-components` warning (mirrors
 * `useFighterFormNow.ts`).
 */
export function useTrendsCardInsights({
  matches,
  horizon,
}: UseTrendsCardInsightsInput): UseTrendsCardInsightsResult {
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch.
  const [nowMs] = useState(() => Date.now());

  return useMemo(
    () => ({
      settingGap: buildOne(SETTING_GAP_TEMPLATE, matches, horizon, nowMs),
      mixShift: buildOne(MIX_SHIFT_TEMPLATE, matches, horizon, nowMs),
      volumeForm: buildOne(VOLUME_FORM_TEMPLATE, matches, horizon, nowMs),
      playRhythm: buildOne(PLAY_RHYTHM_TEMPLATE, matches, horizon, nowMs),
    }),
    [matches, horizon, nowMs],
  );
}

/**
 * Plan 39.1-27 (gap closure, Task 2, WR-A02): `MatchTypeMix.tsx`'s existing
 * WR-A02 composition — `mixShiftTemplate` (packages/shared, which never
 * localises, D-11) emits the stable, raw `matchType` key (e.g.
 * `'online-tourney'`), already localised under `matchForm.matchTypes.*` in
 * all six locale files. This is now the SINGLE place both the MixShift line
 * itself AND `TrendsPage.tsx`'s claim summary resolve that sentence — no
 * raw enum literal ever reaches either rendered surface.
 */
export function buildMixShiftVerdict(insight: Insight, t: TFunction): string {
  const values = { ...insight.copy.values };
  if (typeof values.matchType === 'string') {
    values.matchType = t(`matchForm.matchTypes.${values.matchType}`);
  }
  return t(insight.copy.key, values);
}

/**
 * The values `insights.playRhythm.*` interpolates, with the two locale-bearing ones formatted HERE
 * (the engine never localises, D-11): the month-of-year number becomes the locale's long month name
 * and the 0-1 share becomes the locale's percent. Absent when the template stated no busiest month.
 */
function playRhythmValues(insight: Insight, locale: string): Record<string, string | number> {
  const values: Record<string, string | number> = { ...insight.copy.values };
  if (typeof values.month === 'number') {
    values.month = formatMonthName(values.month, locale, 'long');
  }
  if (typeof values.share === 'number') {
    values.share = formatPercent(values.share, locale);
  }
  return values;
}

/** The `PlayRhythm` verdict sentence (Trends' card and the terminus claim summary share this one spelling). */
export function buildPlayRhythmVerdict(insight: Insight, t: TFunction, locale: string): string {
  return t(insight.copy.key, playRhythmValues(insight, locale));
}

/**
 * The `PlayRhythm` evidence line: with the busiest month when the template stated one, the plain
 * months-played line otherwise.
 */
export function buildPlayRhythmEvidence(insight: Insight, t: TFunction, locale: string): string {
  const values = playRhythmValues(insight, locale);
  const key = typeof insight.copy.values.month === 'number' ? 'evidence' : 'evidenceNoSeason';
  return t(`insights.playRhythm.${key}`, values);
}
