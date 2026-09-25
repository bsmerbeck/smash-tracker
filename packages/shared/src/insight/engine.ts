import type { Match } from '../match.js';
import { isCountableGame } from '../evidence/predicate.js';
import type { HorizonKey, Insight, InsightScope } from './types.js';
import { INSIGHT_TEMPLATES } from './templates/registry.js';
import { scoreInsight } from './salience.js';

/**
 * The one entry point that turns a `Match[]` plus a horizon into typed,
 * salience-ranked `Insight[]` (INS-01). Filters to countable games ONCE,
 * runs every registered template over every requested scope, drops
 * dismissed ids, and returns the result sorted by descending salience with
 * ties broken by `templateId` then `scopeKey` — so the same input always
 * produces the same output order (determinism, D-14).
 *
 * A thrown error inside one template is caught here and that template's
 * output for that scope is dropped; the rest of the run continues
 * (UI-SPEC §9.5's per-card error rule, T-39.1-01-03) — the catch logs
 * nothing that could carry a uid, tag or email.
 *
 * `salience` is populated HERE, once, via `salience.ts`'s `scoreInsight` —
 * a template never sets its own final salience (each template returns a
 * `0` placeholder, overwritten below before sorting). Centralizing this in
 * the one place every `Insight` passes through keeps the formula
 * un-duplicated and matches `salience.ts`'s own doc comment that nothing
 * outside the `Insight.salience` field should ever see a raw score.
 */
export function computeInsights(input: {
  matches: Match[];
  scopes: InsightScope[];
  horizon: HorizonKey;
  nowMs: number;
  dismissedIds?: readonly string[];
}): Insight[] {
  const { matches, scopes, horizon, nowMs, dismissedIds } = input;
  const countable = matches.filter(isCountableGame);
  const dismissed = new Set(dismissedIds ?? []);

  const results: Insight[] = [];
  for (const scope of scopes) {
    for (const template of INSIGHT_TEMPLATES) {
      try {
        const built = template.build({ matches: countable, scope, horizon, nowMs });
        for (const insight of built) {
          if (!dismissed.has(insight.id)) {
            insight.salience = scoreInsight(insight, nowMs);
            results.push(insight);
          }
        }
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => {
    if (b.salience !== a.salience) {
      return b.salience - a.salience;
    }
    if (a.templateId !== b.templateId) {
      return a.templateId < b.templateId ? -1 : 1;
    }
    if (a.scopeKey !== b.scopeKey) {
      return a.scopeKey < b.scopeKey ? -1 : 1;
    }
    return 0;
  });

  return results;
}
