import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 *
 * DELIBERATE PHASE 27 EXTENSION (27-11, RPT-04): Phase 27 adds
 * `apps/web/src/pages/Tournaments/prepPaid/` — the ONE directory that is
 * SUPPOSED to contain monetization vocabulary (`PrepPaidReportsCard` and
 * its siblings; 27-CONTEXT.md, 27-RESEARCH.md Pitfall 6). The correct
 * response is NOT to add `prepPaid/` to the hand-maintained `scannedFiles`
 * list above — that would defeat the paid card's entire purpose — but to
 * widen this gate's REACH to cover the whole `Tournaments/` source tree
 * (so a future file this test's original author never anticipated is
 * caught automatically) while carving `prepPaid/` out as the one
 * deliberately-exempted region, and to prove the exemption stays exactly
 * that with a machine-checked exact-set-equality assertion rather than a
 * hand-maintained exclusion list nobody double-checks. The widened block
 * below SUPPLEMENTS every assertion above — none of it is weakened,
 * deleted, or relaxed. A Phase 27 author was expected to come back and
 * update this file deliberately rather than route around it; this is that
 * update.
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

const TOURNAMENTS_ROOT = resolve('src/pages/Tournaments');
const PREP_PAID_DIR = resolve('src/pages/Tournaments/prepPaid');

/**
 * Recursively collects every non-test `.ts`/`.tsx` source file under `dir`,
 * skipping any directory listed in `excludeDirs` entirely.
 */
function collectSourceFiles(dir: string, excludeDirs: string[] = []): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (excludeDirs.includes(fullPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath, excludeDirs));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * The WIDENED set (27-11): every non-test source file anywhere under
 * `Tournaments/`, EXCLUDING the deliberately-exempted `prepPaid/`
 * directory. This SUPPLEMENTS `scannedFiles` above — it does not replace
 * it — so a future refactor that moves a file out of `prep/` cannot
 * quietly escape the original, hand-maintained gate; both gates must pass.
 */
const wideTournamentsTreeFiles = collectSourceFiles(TOURNAMENTS_ROOT, [PREP_PAID_DIR]);

/** Every non-test source file inside the deliberately-exempted directory. */
const gatedDirFiles = collectSourceFiles(PREP_PAID_DIR);

/**
 * Every non-test source file anywhere under `Tournaments/`, INCLUDING
 * `prepPaid/` — used only by the sole-paid-surface equality check below.
 */
const wholeTournamentsTreeFiles = [...wideTournamentsTreeFiles, ...gatedDirFiles];

describe('deliberate Phase 27 extension: the whole Tournaments tree, minus the gated prepPaid/ directory (RPT-04)', () => {
  it('discovers strictly more source files than the original hand-maintained scanned list (anti-vacuous-pass guard for the widened set)', () => {
    expect(wideTournamentsTreeFiles.length).toBeGreaterThan(scannedFiles.length);
  });

  it('the paid card file exists in the gated directory (a rename or deletion must fail this suite, not silently pass)', () => {
    expect(existsSync(resolve(PREP_PAID_DIR, 'PrepPaidReportsCard.tsx'))).toBe(true);
  });

  it.each(wideTournamentsTreeFiles)(
    '%s (outside prepPaid/) contains no monetization vocabulary',
    (file) => {
      const source = readFileSync(file, 'utf-8');
      expect(source).not.toMatch(MONETIZATION_VOCABULARY);
    },
  );

  it.each(wideTournamentsTreeFiles)(
    '%s (outside prepPaid/) contains no reserved paid-placement marker',
    (file) => {
      const source = readFileSync(file, 'utf-8');
      expect(source).not.toMatch(RESERVED_PLACEMENT_MARKER);
    },
  );

  it('PrepPaidReportsCard.tsx (and its prepPaid/ siblings) are the SOLE files in the whole Tournaments tree matching the monetization-vocabulary regex — exact set equality, not a "contains" check', () => {
    const matchingFiles = new Set(
      wholeTournamentsTreeFiles.filter((file) =>
        MONETIZATION_VOCABULARY.test(readFileSync(file, 'utf-8')),
      ),
    );
    const matchingFilesInsideGatedDir = new Set(
      [...matchingFiles].filter((file) => file.startsWith(`${PREP_PAID_DIR}/`)),
    );
    // A `.some()`/`.includes()` "contains" check could pass even if a file
    // OUTSIDE prepPaid/ also matched, as long as one gated-dir file
    // matched too. Comparing the FULL matching set (computed across the
    // whole tree) against its own gated-dir-only subset via `toEqual`
    // cannot: it fails the instant any element of `matchingFiles` sits
    // outside `matchingFilesInsideGatedDir` — i.e. the instant any file
    // outside prepPaid/ carries monetization vocabulary.
    expect(matchingFiles).toEqual(matchingFilesInsideGatedDir);
    // Non-empty, so this isn't a vacuous pass where nothing matches
    // anywhere (which would trivially satisfy the equality above too).
    expect(matchingFiles.size).toBeGreaterThan(0);
  });

  it('no file outside the gated directory imports from prepPaid/, except PrepBriefPage.tsx (the sole permitted composer)', () => {
    const importers = wideTournamentsTreeFiles.filter((file) =>
      /from ['"].*\/prepPaid\//.test(readFileSync(file, 'utf-8')),
    );
    expect(importers).toEqual([resolve('src/pages/Tournaments/PrepBriefPage.tsx')]);
  });
});
