import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ABSTAINED_KEYS,
  CONFIDENCE_TIER_KEYS,
  FORBIDDEN_CONFIDENCE_WORDS,
  LICENSED_CONFIDENCE_WORDS,
  SAMPLE_CUE_KEY,
  confidenceWordsFor,
} from './confidencePhrases.js';
import type { ConfidenceTier } from './types.js';
import { ADVERSARIAL_FIXTURES } from './adversarialFixtures.js';

/**
 * D-03/RPT-06/C1-H4 (phase 39 plan 03): proves the licensed-confidence
 * table resolves against the REAL shipped `en.json` bundle (not a guessed
 * path — read via `import.meta.url`, mirroring `purity.test.ts`'s own
 * approach, so this works regardless of the runner's cwd) and that
 * `FORBIDDEN_CONFIDENCE_WORDS` passes its own falsifiable admission
 * criterion against the `ordinary_prose` negative corpus.
 */

const EN_BUNDLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/web/src/i18n/locales/en.json',
);

function resolvePath(bundle: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((node, segment) => {
    if (node !== null && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, bundle);
}

describe('CONFIDENCE_TIER_KEYS / ABSTAINED_KEYS resolve in the real English bundle', () => {
  const bundle: unknown = JSON.parse(readFileSync(EN_BUNDLE_PATH, 'utf8'));

  it('every tier key resolves to a non-empty string via its i18next-pluralized _one leaf', () => {
    const tiers: ConfidenceTier[] = ['low', 'medium', 'high'];
    for (const tier of tiers) {
      const key = CONFIDENCE_TIER_KEYS[tier];
      expect(key.startsWith(SAMPLE_CUE_KEY)).toBe(true);
      const resolved = resolvePath(bundle, `${key}_one`);
      expect(typeof resolved).toBe('string');
      expect(resolved).not.toBe('');
    }
  });

  it('both abstained keys resolve to non-empty strings directly (already full leaf keys)', () => {
    for (const key of [ABSTAINED_KEYS.one, ABSTAINED_KEYS.other]) {
      const resolved = resolvePath(bundle, key);
      expect(typeof resolved).toBe('string');
      expect(resolved).not.toBe('');
    }
  });
});

describe('licensed/forbidden vocabulary contract', () => {
  it('the licensed and forbidden lists are disjoint', () => {
    const licensed = new Set(Object.values(LICENSED_CONFIDENCE_WORDS).flat());
    for (const word of FORBIDDEN_CONFIDENCE_WORDS) {
      expect(licensed.has(word)).toBe(false);
    }
  });

  it('no tier maps to an empty list', () => {
    for (const words of Object.values(LICENSED_CONFIDENCE_WORDS)) {
      expect(words.length).toBeGreaterThan(0);
    }
  });

  it('confidenceWordsFor(null) returns only the abstained vocabulary, disjoint from any tier list', () => {
    const abstainedWords = confidenceWordsFor(null);
    expect(abstainedWords.length).toBeGreaterThan(0);
    const tierWords = new Set(Object.values(LICENSED_CONFIDENCE_WORDS).flat());
    for (const word of abstainedWords) {
      expect(tierWords.has(word)).toBe(false);
    }
  });

  it("confidenceWordsFor(tier) returns exactly that tier's licensed list", () => {
    expect(confidenceWordsFor('low')).toEqual(LICENSED_CONFIDENCE_WORDS.low);
    expect(confidenceWordsFor('medium')).toEqual(LICENSED_CONFIDENCE_WORDS.medium);
    expect(confidenceWordsFor('high')).toEqual(LICENSED_CONFIDENCE_WORDS.high);
  });
});

describe('C1-H4 false-positive canary: FORBIDDEN_CONFIDENCE_WORDS must pass clean against ordinary_prose', () => {
  it('no token in the ordinary_prose fixture corpus matches a forbidden word', () => {
    const ordinaryProseFixtures = ADVERSARIAL_FIXTURES.filter((f) => f.family === 'ordinary_prose');
    // Self-check: this must not vacuously pass over zero fixtures — the
    // corpus family must actually exist and carry prose sections.
    expect(ordinaryProseFixtures.length).toBeGreaterThan(0);

    const forbidden = new Set(FORBIDDEN_CONFIDENCE_WORDS);
    let sectionsChecked = 0;
    for (const fixture of ordinaryProseFixtures) {
      for (const section of fixture.sections ?? []) {
        sectionsChecked += 1;
        const tokens = section.prose.toLowerCase().match(/[a-z']+/g) ?? [];
        for (const token of tokens) {
          expect(forbidden.has(token)).toBe(false);
        }
      }
    }
    expect(sectionsChecked).toBeGreaterThan(0);
  });
});
