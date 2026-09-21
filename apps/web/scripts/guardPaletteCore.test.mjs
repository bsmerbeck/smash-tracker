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
import {
  LIGHTNESS_BAND,
  CONTRAST_MIN,
  CVD_FLOOR,
  TOKEN_NAMES,
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
  assert.ok(Math.abs(withoutExemption[0].ratio - 2.4) < 0.01, `expected ~2.40:1, got ${withoutExemption[0].ratio}`);
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
