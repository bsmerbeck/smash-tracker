import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 26-CONTEXT.md D-11: `tournament_prep_activated` is a Phase 13 once-per-user
 * onboarding milestone meaning "this user has at least one tournament
 * registry row." Phase 26 needed a per-event activation signal and
 * therefore defined entirely new event names (`prep_brief_*`/`prep_offer_*`)
 * rather than reusing, renaming, or re-keying that one. This gate fails if a
 * future change blurs the two: it proves, by content read, that Phase 13's
 * activation function, its uid-scoped dedup key, and its GA4 allowlist row
 * are unchanged, and that no Phase 26 event name has reached the GA4
 * payload allowlist (D-10). A content-based grep-gate rather than a
 * `git diff`, mirroring `apps/web/src/routes/coachChromeIntegrity.test.ts`
 * and `apps/api/src/prep/importGraph.test.ts`'s precedent, so it stays
 * meaningful regardless of which commit or worktree it runs from.
 */
describe('Phase 13 activation family untouched by Phase 26 (D-11)', () => {
  const activationSource = readFileSync(resolve('src/onboarding/activation.ts'), 'utf-8');
  const ga4ProjectSource = readFileSync(resolve('src/events/ga4Project.ts'), 'utf-8');

  it('reads non-empty source for both files (a moved/renamed file must fail loudly, not pass on an empty read)', () => {
    expect(activationSource.length).toBeGreaterThan(0);
    expect(ga4ProjectSource.length).toBeGreaterThan(0);
  });

  it('activation.ts still exports computeActivationState', () => {
    expect(activationSource).toContain('export async function computeActivationState(');
  });

  it('activation.ts still emits the tournament_prep_activated milestone', () => {
    expect(activationSource).toContain('tournament_prep_activated');
  });

  it('activation.ts still reads the uid-scoped dedup path for tournament_prep_activated', () => {
    expect(activationSource).toContain('eventDedup/tournament_prep_activated/');
  });

  it('ga4Project.ts still allowlists tournament_prep_activated with onboardingCause', () => {
    expect(ga4ProjectSource).toContain("tournament_prep_activated: ['onboardingCause'],");
  });

  it('ga4Project.ts has no Phase 26 event name in its GA4 payload allowlist (D-10)', () => {
    expect(ga4ProjectSource).not.toMatch(/prep_(brief|offer)_/);
  });
});
