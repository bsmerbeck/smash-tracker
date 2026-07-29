import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RPT-04 (26-CONTEXT.md D-09, 26-UI-SPEC.md "Hard rule — no paid affordance
 * color or copy of any kind" / "No paid-placement DOM node"): Phase 26 ships
 * the free prep brief only. Phase 27 owns the entire paid surface, and per
 * RPT-04 the structural-absence rule starts here — this phase's markup must
 * not contain even a hidden placeholder for a future placement, and its
 * copy must not contain monetization vocabulary. This is a content-based
 * grep-gate rather than a `git diff`, mirroring
 * `apps/web/src/routes/coachChromeIntegrity.test.ts` and
 * `apps/api/src/prep/importGraph.test.ts`'s precedent, so it stays
 * meaningful regardless of which commit or worktree it runs from — and
 * fails CI loudly the moment a future edit (including a Phase 27 author who
 * should update this file deliberately, not route around it) reintroduces a
 * paid affordance or a reserved placement slot.
 */

const MONETIZATION_VOCABULARY =
  /upgrade|unlock|paywall|pricing|price|checkout|stripe|coming soon|\$\d/i;
const RESERVED_PLACEMENT_MARKER = /data-[a-z-]*(placement|offer|promo|upsell)|display:\s*none/i;

const PREP_DIR = resolve('src/pages/Tournaments/prep');

const prepDirFiles = readdirSync(PREP_DIR)
  .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))
  .map((file) => resolve(PREP_DIR, file));

const EXTRA_SURFACE_FILES = [
  resolve('src/pages/Tournaments/PrepBriefPage.tsx'),
  resolve('src/pages/Tournaments/components/PrepManualEntryDialog.tsx'),
  resolve('src/pages/Dashboard/components/DashboardPrepActionSlot.tsx'),
];

const scannedFiles = [...prepDirFiles, ...EXTRA_SURFACE_FILES];

describe('prep structural integrity (no paid affordance, RPT-04)', () => {
  it('discovers more than 4 surfaces to scan (a silently-empty file list would make every case below vacuously pass)', () => {
    expect(scannedFiles.length).toBeGreaterThan(4);
  });

  it('scans PrepBriefPage.tsx (a path rename would otherwise silently empty the list)', () => {
    expect(scannedFiles.some((file) => file.endsWith('PrepBriefPage.tsx'))).toBe(true);
  });

  it.each(scannedFiles)('%s contains no monetization vocabulary', (file) => {
    const source = readFileSync(file, 'utf-8');
    expect(source).not.toMatch(MONETIZATION_VOCABULARY);
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

  it('the prep i18n copy bundle contains no monetization vocabulary', () => {
    const bundle = JSON.parse(readFileSync(resolve('src/i18n/locales/en.json'), 'utf-8'));
    expect(JSON.stringify(bundle.prep)).not.toMatch(MONETIZATION_VOCABULARY);
  });
});
