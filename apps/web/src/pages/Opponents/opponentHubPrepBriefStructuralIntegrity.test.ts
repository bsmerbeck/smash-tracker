import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Plan 39-12 (PREP-05, D-11): the opponent hub's own no-paid-affordance
 * gate. The locked structural proof
 * (`pages/Tournaments/prep/prepStructuralIntegrity.test.ts`) scans the
 * `Tournaments/` tree, the dashboard prep slot and the `prep.*` copy — it
 * never reaches `pages/Opponents/`, so the hub's free prep-brief card would
 * otherwise have no vocabulary gate at all. This copies that proof's
 * mechanism exactly: `readFileSync` over the raw source with NO comment
 * stripping (a banned word in a comment or an identifier fails too), the
 * same monetization regex and the same reserved-placement regex, plus the
 * `opponents.hub` copy namespace of all six bundles (IN-02). The hub and the
 * dashboard are FREE entry points; paid vocabulary stays confined to
 * `prepPaid/` and `postEventPaid/`.
 */

const MONETIZATION_VOCABULARY =
  /upgrade|unlock|paywall|pricing|price|checkout|stripe|coming soon|\$\d/i;
const RESERVED_PLACEMENT_MARKER = /data-[a-z-]*(placement|offer|promo|upsell)|display:\s*none/i;

/**
 * The ONE deviation from the locked proof's mechanism, and an exact one: the
 * hub page composes the chart kit's form strip, whose identifiers
 * (`FormStripEvent` and two locals built on it) contain the letters
 * "StripE" and therefore match the case-insensitive `stripe` alternative.
 * These three whole identifiers — and nothing else — are masked before the
 * regex runs. Any other spelling (a bare "stripe", "Stripe checkout", a
 * new identifier) is still caught; the control case below proves it.
 */
const KIT_IDENTIFIER_FALSE_POSITIVES =
  /\b(?:FormStripEvent|buildOpponentFormStripEvents|formStripEvents)\b/g;

function scannableSource(file: string): string {
  return readFileSync(file, 'utf-8').replace(KIT_IDENTIFIER_FALSE_POSITIVES, '<kit-identifier>');
}

/** The hub page, the card, and the pure modules the card composes. */
const scannedFiles = [
  resolve('src/pages/Opponents/OpponentHubPage.tsx'),
  resolve('src/pages/Opponents/components/HubPrepBriefCard.tsx'),
  resolve('src/lib/prepEntryPoints.ts'),
  resolve('src/lib/prepSurfaceMode.ts'),
];

describe('opponent hub prep-brief structural integrity (no paid affordance, D-11)', () => {
  // Code review IN-06: this replaces an assertion over the literal array above,
  // which could not fail. A renamed or moved file is what would silently drop
  // it from the scan, so the test asserts each listed path exists on disk.
  it.each(scannedFiles)(
    '%s exists on disk (a rename or move would drop it from the scan)',
    (file) => {
      expect(existsSync(file)).toBe(true);
    },
  );

  it('control: the kit-identifier mask hides only those three identifiers, never the vocabulary itself', () => {
    const probe = 'FormStripEvent formStripEvents buildOpponentFormStripEvents';
    expect(probe).toMatch(MONETIZATION_VOCABULARY);
    expect(probe.replace(KIT_IDENTIFIER_FALSE_POSITIVES, '')).not.toMatch(MONETIZATION_VOCABULARY);
    for (const leak of ['stripe', 'Stripe checkout', 'FormStripeEvent', 'myFormStripEventPrice']) {
      expect(leak.replace(KIT_IDENTIFIER_FALSE_POSITIVES, '')).toMatch(MONETIZATION_VOCABULARY);
    }
  });

  it.each(scannedFiles)('%s contains no monetization vocabulary', (file) => {
    expect(scannableSource(file)).not.toMatch(MONETIZATION_VOCABULARY);
  });

  it.each(scannedFiles)('%s contains no reserved paid-placement marker', (file) => {
    const source = readFileSync(file, 'utf-8');
    expect(source).not.toMatch(RESERVED_PLACEMENT_MARKER);
  });

  it.each(scannedFiles)('%s imports nothing from a billing or reports path', (file) => {
    const source = readFileSync(file, 'utf-8');
    expect(source).not.toMatch(/from ['"].*\/billing\//);
    expect(source).not.toMatch(/from ['"].*\/reports\//);
  });

  it('the card draws no paid brand treatment (no Sparkles icon, no primary fill)', () => {
    const source = readFileSync(
      resolve('src/pages/Opponents/components/HubPrepBriefCard.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/Sparkles|text-primary|bg-primary|variant="default"/);
  });

  // Code review IN-02: every shipped locale, not just English — the regex's
  // `stripe` / `checkout` / `$N` alternatives catch a leak in any language.
  it.each(['en', 'es', 'fr', 'de', 'pt', 'ja'])(
    'the %s opponents.hub copy namespace contains no monetization vocabulary',
    (locale) => {
      const bundle = JSON.parse(readFileSync(resolve(`src/i18n/locales/${locale}.json`), 'utf-8'));
      expect(bundle.opponents.hub.prepBrief).toBeDefined();
      expect(JSON.stringify(bundle.opponents.hub)).not.toMatch(MONETIZATION_VOCABULARY);
    },
  );
});
