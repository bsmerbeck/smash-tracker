/**
 * D-03/RPT-06 (phase 39 plan 03): the closed licensed-confidence vocabulary
 * the prose lint (plan 39-04) checks a generated report's connective English
 * against. KEYS and WORD LISTS only — no user-facing sentence lives in this
 * module; every rendered word still comes from the shipped i18n bundles
 * (`apps/web/src/i18n/locales/*.json`), read through the SAME `t()` call
 * sites this module merely names (`EvidenceCues.tsx`'s `SampleCue`
 * component).
 */
import type { ConfidenceTier } from './types.js';

/**
 * The shipped whole-sentence i18n namespace (Phase 39.1 Plan 11's re-key —
 * `apps/web/src/i18n/locales/en.json`'s `shared.evidence.sampleCue` object).
 * i18next resolves the plural suffix (`_one`/`_other`) itself from a
 * `count` interpolation value, so a caller passes this BASE key (never the
 * `_one` suffix form) to `t()` — the exact call `EvidenceCues.tsx`'s
 * `SampleCue` component already makes:
 * ``t(`shared.evidence.sampleCue.${tier}`, { count })``.
 */
export const SAMPLE_CUE_KEY = 'shared.evidence.sampleCue';

/**
 * Each tier's shipped whole-sentence i18n key (base form, plural-resolved
 * by `t()`) — `confidencePhrases.test.ts` reads the ACTUAL `en.json` bundle
 * and proves every one of these resolves to a real leaf (`${key}_one`), so
 * a renamed shipped key fails a committed test rather than at render time.
 */
export const CONFIDENCE_TIER_KEYS: Readonly<Record<ConfidenceTier, string>> = {
  low: `${SAMPLE_CUE_KEY}.low`,
  medium: `${SAMPLE_CUE_KEY}.medium`,
  high: `${SAMPLE_CUE_KEY}.high`,
};

/**
 * The shipped abstained-claim sentence's `_one`/`_other` pair — already
 * full leaf keys, unlike `CONFIDENCE_TIER_KEYS` above (no further suffix to
 * resolve).
 */
export const ABSTAINED_KEYS: Readonly<{ one: string; other: string }> = {
  one: 'shared.evidence.abstained_one',
  other: 'shared.evidence.abstained_other',
};

/**
 * The LICENCE list — NOT display copy. The app always renders through i18n
 * (`CONFIDENCE_TIER_KEYS`/`ABSTAINED_KEYS` above); this is the closed set of
 * ENGLISH lowercase words the prose lint (plan 39-04) accepts in the
 * MODEL's connective prose when it describes confidence, derived from the
 * shipped tier vocabulary — the tier word itself, plus "confidence", the
 * noun every shipped sentence pairs it with. Adding a word tightens the
 * lint and needs the `ordinary_prose` corpus re-run (see
 * `FORBIDDEN_CONFIDENCE_WORDS` below); removing one loosens it and needs a
 * fixture.
 */
export const LICENSED_CONFIDENCE_WORDS: Readonly<Record<ConfidenceTier, readonly string[]>> = {
  low: ['low', 'confidence'],
  medium: ['medium', 'confidence'],
  high: ['high', 'confidence'],
};

/**
 * The abstained case's licensed vocabulary — every substantive word of the
 * shipped `shared.evidence.abstained_one`/`_other` sentence ("Not enough
 * data yet — {{count}} more game(s) needed."), never a new phrase.
 */
const ABSTAINED_LICENSED_WORDS: readonly string[] = ['not', 'enough', 'data', 'yet'];

/**
 * The strength/hedge vocabulary the lint rejects outright, regardless of
 * tier. Review C1-H4: membership here is bound by a FALSIFIABLE admission
 * criterion, not a taste call — a word may appear ONLY IF plan 39-01's
 * `ordinary_prose` negative corpus (`adversarialFixtures.ts`) still passes
 * clean with it in (`confidencePhrases.test.ts`'s own canary test asserts
 * this with a zero-tolerance budget).
 *
 * EXCLUDED, and why (do not re-add without re-running the corpus check):
 * - `always`, `never` — the plan's own starter list named both, but the
 *   `ordinary_prose` corpus USES each in ordinary coaching idiom ("Fox
 *   players... never assume a cloud of pressure is safe", "a calm gamer
 *   never panics off one bad game", "they almost always take their
 *   strike-order pick 3rd") — including either would fail the corpus
 *   canary outright, a real false positive this admission criterion exists
 *   to catch.
 * - `could`, `might`, `likely`, `probably`, `seems`, `appears` — per the
 *   plan's explicit instruction: ordinary recommendation English ("you
 *   could counterpick Battlefield") uses these in a non-confidence sense,
 *   and the corpus's own connective prose ("could swing Game 1", "could
 *   pressure you into a bad approach", "might just be habit") confirms the
 *   same usage — none were added.
 */
export const FORBIDDEN_CONFIDENCE_WORDS: readonly string[] = [
  'dominant',
  'crush',
  'guaranteed',
  'clearly',
  'obviously',
  'definitely',
];

/**
 * The abstained case (`tier: null`) licenses only the abstention
 * vocabulary — never a tier word, since there is no tier below the floor.
 */
export function confidenceWordsFor(tier: ConfidenceTier | null): readonly string[] {
  if (tier === null) {
    return ABSTAINED_LICENSED_WORDS;
  }
  return LICENSED_CONFIDENCE_WORDS[tier];
}
