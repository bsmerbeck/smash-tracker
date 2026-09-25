#!/usr/bin/env node
/**
 * Palette-validation THIN RUNNER (Phase 39.1 Plan 10, UIX-05, UI-SPEC §13.6):
 * reads `apps/web/src/index.css` FROM DISK — never a copied table — resolves
 * the seven visualization tokens plus the card surface, runs every check in
 * `guardPaletteCore.mjs`, prints every violation, and exits non-zero if any
 * exist. `pnpm --filter @smash-tracker/web run guard:palette`.
 *
 * T-39.1-10-01 (Repudiation): a palette claim asserted from a copied table.
 * Mitigation: this file's only source of colour values is `readFileSync`
 * against the real stylesheet path below — no hex literal for any of the
 * seven tokens appears anywhere in this file (asserted by
 * `chartKitBoundary.test.ts`'s companion source scan is out of scope for a
 * scripts/ file; this file's own doc comment states the property directly
 * and the SUMMARY records a source grep proving it).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TOKEN_NAMES,
  CARD_SURFACE_NAME,
  CVD_PAIRS,
  parseTokenHexes,
  checkLightnessBand,
  checkChromaFloor,
  checkContrastOnSurface,
  checkColourVisionSeparation,
} from './guardPaletteCore.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(REPO_ROOT, 'src/index.css');

function main() {
  const cssSource = readFileSync(CSS_PATH, 'utf8');
  const tokenHexes = parseTokenHexes(cssSource, TOKEN_NAMES);
  const surfaceEntry = parseTokenHexes(cssSource, [CARD_SURFACE_NAME])[CARD_SURFACE_NAME];

  const violations = [];

  for (const [name, entry] of Object.entries(tokenHexes)) {
    if (entry.missing) {
      violations.push({ check: 'missing-token', token: name, error: entry.error });
    }
  }
  if (surfaceEntry.missing) {
    violations.push({ check: 'missing-token', token: CARD_SURFACE_NAME, error: surfaceEntry.error });
  }

  // Every remaining check needs every token resolved to reason about it
  // meaningfully — a MISSING token is already reported above and is excluded
  // from these (checkColourVisionSeparation reports it again per-pair, since
  // a pair naming a missing token is its own distinct, actionable violation).
  violations.push(...checkLightnessBand(tokenHexes));
  violations.push(...checkChromaFloor(tokenHexes));
  if (!surfaceEntry.missing) {
    violations.push(...checkContrastOnSurface(tokenHexes, surfaceEntry.hex));
  }
  violations.push(...checkColourVisionSeparation(tokenHexes, CVD_PAIRS));

  for (const violation of violations) {
    console.error('VIOLATION', JSON.stringify(violation));
  }

  const resolvedCount = TOKEN_NAMES.filter((name) => !tokenHexes[name].missing).length;
  console.log(`TOKENS_RESOLVED=${resolvedCount}/${TOKEN_NAMES.length}`);
  console.log(`VIOLATIONS=${violations.length}`);

  process.exit(violations.length > 0 ? 1 : 0);
}

main();
