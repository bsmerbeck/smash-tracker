/**
 * Plain Node test file (Phase 39.1 Plan 10) exercising `guardPaletteCore.mjs`
 * with synthetic inputs — no file read, no CSS parsing beyond the tiny
 * literal fixtures below. Run directly via
 * `node --test apps/web/scripts/guardPaletteCore.test.mjs`, the same
 * invocation style `guardLayoutCore.test.mjs` (plan 39.1-09) already
 * establishes for this repo's Node-runner scripts, and excluded from the
 * default vitest sweep for the identical reason (see `vitest.config.ts`'s
 * doc comment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  LIGHTNESS_BAND,
  CONTRAST_MIN,
  CVD_FLOOR,
  TOKEN_NAMES,
  TIER_TOKEN_NAMES,
  TIER_MIN_DELTA_L,
  CVD_PAIRS,
  CARD_SURFACE_NAME,
  parseTokenHexes,
  contrastRatio,
  oklch,
  oklchToHex,
  deltaE,
  checkLightnessBand,
  checkChromaFloor,
  checkContrastOnSurface,
  checkColourVisionSeparation,
  checkTierRamp,
} from './guardPaletteCore.mjs';

const FIXTURE_ROOT_CSS = `
:root {
  --chart-4: oklch(0.62 0.17 255);
  --chart-2: oklch(0.75 0 0);
  --chart-5: oklch(0.45 0 0);
  --chart-3: #c98500;
  --destructive: oklch(0.63 0.23 29);
  --muted-foreground: oklch(0.72 0 0);
  --viz-series-1: var(--chart-4);
  --viz-series-2: var(--chart-3);
  --viz-context: var(--chart-2);
  --viz-context-strong: var(--chart-5);
  --win: #059669;
  --loss: var(--destructive);
  --steady: var(--muted-foreground);
  --card: oklch(0.205 0.006 285);
}
.dark {
  --win: #ff0000;
}
`;

test('oklch<->hex round-trips within floating-point tolerance', () => {
  const hex = oklchToHex(0.62, 0.17, 255);
  const [L, C] = oklch(hex);
  assert.ok(Math.abs(L - 0.62) < 0.01, `L round-trip off: ${L}`);
  assert.ok(Math.abs(C - 0.17) < 0.01, `C round-trip off: ${C}`);
});

test('parseTokenHexes resolves a var() chain, a literal hex, and an oklch() literal from :root — never from .dark', () => {
  const resolved = parseTokenHexes(FIXTURE_ROOT_CSS, [...TOKEN_NAMES, CARD_SURFACE_NAME]);
  assert.equal(resolved['viz-series-1'].hex, '#3186e9');
  assert.equal(resolved.win.hex, '#059669');
  assert.equal(resolved['viz-series-2'].hex, '#c98500');
  assert.equal(resolved.card.hex, '#17171a');
});

test('parseTokenHexes reports a token the stylesheet does not declare as MISSING, never skipped', () => {
  const resolved = parseTokenHexes(FIXTURE_ROOT_CSS, ['not-a-real-token']);
  assert.equal(resolved['not-a-real-token'].missing, true);
  assert.match(resolved['not-a-real-token'].error, /is not declared/);
});

test('parseTokenHexes reports a dangling var() reference as MISSING with a descriptive error, not a thrown exception', () => {
  const danglingCss = ':root { --broken: var(--never-declared); }';
  const resolved = parseTokenHexes(danglingCss, ['broken']);
  assert.equal(resolved.broken.missing, true);
  assert.match(resolved.broken.error, /is not declared/);
});

test('the real seven-token set (as declared in this fixture) clears the lightness band, chroma floor, contrast, and CVD checks', () => {
  const tokenHexes = parseTokenHexes(FIXTURE_ROOT_CSS, TOKEN_NAMES);
  const surface = parseTokenHexes(FIXTURE_ROOT_CSS, [CARD_SURFACE_NAME])[CARD_SURFACE_NAME].hex;
  assert.deepEqual(checkLightnessBand(tokenHexes), []);
  assert.deepEqual(checkChromaFloor(tokenHexes), []);
  assert.deepEqual(checkContrastOnSurface(tokenHexes, surface), []);
  assert.deepEqual(checkColourVisionSeparation(tokenHexes, CVD_PAIRS), []);
});

test('NAMED FAILING CASE (UI-SPEC §13.6): emerald-500 (#10b981) in place of --win fails the dark lightness band', () => {
  const tokenHexes = parseTokenHexes(FIXTURE_ROOT_CSS, TOKEN_NAMES);
  const withEmerald = { ...tokenHexes, win: { hex: '#10b981' } };
  const violations = checkLightnessBand(withEmerald);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].token, 'win');
  assert.equal(violations[0].hex, '#10b981');
  assert.ok(
    violations[0].lightness > LIGHTNESS_BAND.dark[1],
    `expected emerald-500's lightness (${violations[0].lightness}) to exceed the dark-band ceiling ${LIGHTNESS_BAND.dark[1]}`,
  );
});

test('checkLightnessBand and checkChromaFloor exempt --viz-context/--viz-context-strong/--steady by default (documented achromatic-by-design ink)', () => {
  // --viz-context here is oklch(0.75 0 0): L=0.75 is above the dark band AND
  // C=0 is below the chroma floor — both checks would fire without the
  // default exemption.
  const tokenHexes = parseTokenHexes(FIXTURE_ROOT_CSS, TOKEN_NAMES);
  assert.deepEqual(checkLightnessBand(tokenHexes), []);
  assert.deepEqual(checkChromaFloor(tokenHexes), []);
  // Proven WITHOUT the exemption: the same token fails both checks for real,
  // proving the exemption is load-bearing rather than vacuous.
  const withoutExemption = checkLightnessBand(tokenHexes, { exempt: [] });
  assert.ok(withoutExemption.some((v) => v.token === 'viz-context'));
  const chromaWithoutExemption = checkChromaFloor(tokenHexes, { exempt: [] });
  assert.ok(chromaWithoutExemption.some((v) => v.token === 'viz-context'));
});

test('checkContrastOnSurface exempts --viz-context-strong by default (UI-SPEC §4.1: 2.40:1, documented decorative)', () => {
  const tokenHexes = parseTokenHexes(FIXTURE_ROOT_CSS, TOKEN_NAMES);
  const surface = parseTokenHexes(FIXTURE_ROOT_CSS, [CARD_SURFACE_NAME])[CARD_SURFACE_NAME].hex;
  assert.deepEqual(checkContrastOnSurface(tokenHexes, surface), []);
  const withoutExemption = checkContrastOnSurface(tokenHexes, surface, { exempt: [] });
  assert.equal(withoutExemption.length, 1);
  assert.equal(withoutExemption[0].token, 'viz-context-strong');
  assert.ok(
    Math.abs(withoutExemption[0].ratio - 2.4) < 0.01,
    `expected ~2.40:1, got ${withoutExemption[0].ratio}`,
  );
});

test('checkContrastOnSurface fails a token below 3:1 that is NOT the documented exemption', () => {
  const tokenHexes = { win: { hex: '#3a3a3a' } };
  const violations = checkContrastOnSurface(tokenHexes, '#17171a', { exempt: [] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].token, 'win');
  assert.ok(violations[0].ratio < CONTRAST_MIN);
});

test('checkColourVisionSeparation fails a pair collapsed to the same colour (worst ΔE = 0, below the floor)', () => {
  const collapsed = { win: { hex: '#059669' }, loss: { hex: '#059669' } };
  const violations = checkColourVisionSeparation(collapsed, [['win', 'loss']]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].worstDeltaE, 0);
  assert.ok(violations[0].worstDeltaE < CVD_FLOOR);
});

test('checkColourVisionSeparation passes the real {win, loss} pair (measured, not recalled)', () => {
  const tokenHexes = parseTokenHexes(FIXTURE_ROOT_CSS, TOKEN_NAMES);
  const violations = checkColourVisionSeparation(tokenHexes, [['win', 'loss']]);
  assert.deepEqual(violations, []);
});

test('checkColourVisionSeparation reports a MISSING pair member as a violation rather than throwing', () => {
  const withMissing = { win: { hex: '#059669' }, loss: { missing: true, error: 'not declared' } };
  const violations = checkColourVisionSeparation(withMissing, [['win', 'loss']]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].error, /missing\/unresolved/);
});

test('contrastRatio(x, x) is exactly 1 (a colour has no contrast against itself)', () => {
  assert.equal(contrastRatio('#17171a', '#17171a'), 1);
});

test('deltaE(x, x) is exactly 0 under every simulation kind and under normal vision', () => {
  assert.equal(deltaE('#3186e9', '#3186e9'), 0);
  assert.equal(deltaE('#3186e9', '#3186e9', 'protan'), 0);
  assert.equal(deltaE('#3186e9', '#3186e9', 'deutan'), 0);
});

// -- Phase 39.2 plan 06 (UI-SPEC §13 G2): the tier ramp ------------------------------------

/** The five tier tokens as `index.css` declares them (UI-SPEC §4.1), plus the card surface. */
const TIER_FIXTURE_CSS = `
:root {
  --card: oklch(0.205 0.006 285);
  --tier-1: oklch(0.56 0.11 75);
  --tier-2: oklch(0.63 0.12 75);
  --tier-3: oklch(0.70 0.13 75);
  --tier-4: oklch(0.77 0.14 75);
  --tier-5: oklch(0.84 0.13 75);
}
`;

/** `TIER_FIXTURE_CSS` with one declaration replaced, so a failing case differs from the passing one in exactly one token. */
function tierFixtureWith(token, value) {
  return TIER_FIXTURE_CSS.replace(new RegExp(`--${token}: [^;]+;`), `--${token}: ${value};`);
}

function tierCheck(cssSource) {
  const tierHexes = parseTokenHexes(cssSource, TIER_TOKEN_NAMES);
  const surface = parseTokenHexes(cssSource, [CARD_SURFACE_NAME])[CARD_SURFACE_NAME].hex;
  return checkTierRamp(tierHexes, surface);
}

test('the tier ramp is its own list: TOKEN_NAMES is untouched and holds no tier token (the identity lightness band would reject tier-3..5)', () => {
  assert.deepEqual(TOKEN_NAMES, [
    'viz-series-1',
    'viz-series-2',
    'viz-context',
    'viz-context-strong',
    'win',
    'loss',
    'steady',
  ]);
  assert.deepEqual(TIER_TOKEN_NAMES, ['tier-1', 'tier-2', 'tier-3', 'tier-4', 'tier-5']);
  const tierHexes = parseTokenHexes(TIER_FIXTURE_CSS, TIER_TOKEN_NAMES);
  // Proves the separate list is load-bearing: the identity band WOULD flag the lighter steps.
  const bandViolations = checkLightnessBand(tierHexes, { exempt: [] });
  assert.ok(bandViolations.some((v) => v.token === 'tier-5'));
});

test('the tier ramp as declared (fixture literal) clears contrast, gamut and step size', () => {
  assert.deepEqual(tierCheck(TIER_FIXTURE_CSS), []);
});

test('the REAL index.css tier ramp clears all three checks (read from disk, never a copied table)', () => {
  const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css');
  assert.deepEqual(tierCheck(readFileSync(cssPath, 'utf8')), []);
});

test('NAMED FAILING CASE (UI-SPEC §13 G2): --tier-1 at oklch(0.45 0.11 75) fails the 3:1 contrast floor', () => {
  const violations = tierCheck(tierFixtureWith('tier-1', 'oklch(0.45 0.11 75)'));
  const contrast = violations.filter((v) => v.check === 'tier-contrast');
  assert.equal(contrast.length, 1);
  assert.equal(contrast[0].token, 'tier-1');
  assert.ok(
    contrast[0].ratio < CONTRAST_MIN,
    `expected below ${CONTRAST_MIN}, got ${contrast[0].ratio}`,
  );
});

test('NAMED FAILING CASE: --tier-2 as light as --tier-1 fails the adjacent lightness step (delta L below the floor)', () => {
  const violations = tierCheck(tierFixtureWith('tier-2', 'oklch(0.56 0.12 75)'));
  const steps = violations.filter((v) => v.check === 'tier-adjacent-delta-l');
  assert.ok(steps.some((v) => v.pair[0] === 'tier-1' && v.pair[1] === 'tier-2'));
  assert.ok(steps[0].deltaL < TIER_MIN_DELTA_L);
});

test('a ramp that DARKENS with level fails: the step is a signed rise, not an absolute difference', () => {
  const violations = tierCheck(tierFixtureWith('tier-3', 'oklch(0.60 0.13 75)'));
  assert.ok(
    violations.some((v) => v.check === 'tier-adjacent-delta-l' && v.pair[1] === 'tier-3'),
    JSON.stringify(violations),
  );
});

test('NAMED FAILING CASE: an out-of-gamut value fails the gamut check even though its clamped hex would pass contrast', () => {
  const violations = tierCheck(tierFixtureWith('tier-5', 'oklch(0.84 0.4 75)'));
  const gamut = violations.filter((v) => v.check === 'tier-gamut');
  assert.equal(gamut.length, 1);
  assert.equal(gamut[0].token, 'tier-5');
});

test('an in-gamut value at the same lightness does not trip the gamut check (the check discriminates)', () => {
  const violations = tierCheck(tierFixtureWith('tier-5', 'oklch(0.84 0.13 75)'));
  assert.equal(violations.filter((v) => v.check === 'tier-gamut').length, 0);
});

test('a tier token the stylesheet does not declare is reported, never skipped', () => {
  const withoutTier4 = TIER_FIXTURE_CSS.replace(/--tier-4: [^;]+;\n/, '');
  const violations = tierCheck(withoutTier4);
  assert.ok(violations.some((v) => v.check === 'tier-missing' && v.token === 'tier-4'));
});

test('checkTierRamp reports EVERY offender, not just the first', () => {
  const twoBad = tierFixtureWith('tier-1', 'oklch(0.45 0.11 75)').replace(
    /--tier-5: [^;]+;/,
    '--tier-5: oklch(0.84 0.4 75);',
  );
  const checks = tierCheck(twoBad).map((v) => `${v.check}:${v.token ?? v.pair?.join('>')}`);
  assert.ok(checks.includes('tier-contrast:tier-1'));
  assert.ok(checks.includes('tier-gamut:tier-5'));
});
