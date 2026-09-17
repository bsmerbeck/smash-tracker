import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import {
  createLiquipediaFixtureFetch,
  matchQuery,
} from '../src/liquipedia/__fixtures__/loadFixture.js';
import { UnsafeOutputPathError } from './outputPathGuard.js';
import {
  LIQ_SPIKE_TARGETS,
  runLiqSpike,
  assertSafeLiqSpikeOutPath,
  type LiqSpikeTarget,
} from './liqSpikeProbeCore.js';

/**
 * Phase 36 Plan 07 (LIQ-01): exercises `runLiqSpike` end-to-end against the
 * EXISTING committed fixture corpus — zero network. Both request shapes the
 * corpus already contains are reused directly rather than fabricated: the
 * shipped VODs-page stub batch (proving the stub-generator-only and missing
 * verdicts) and the Supernova bracket page (proving the sufficient verdict).
 */

const STUB_BATCH_TARGET: LiqSpikeTarget = {
  family: 'player-results',
  titles: ['Hungrybox/VODs', 'Sparg0/VODs', 'MkLeo/VODs', 'IzAw/VODs'],
  why: 'test double: reuses the existing */VODs stub fixture to exercise the stub-generator-only and missing verdicts.',
};

const SUBSTANTIVE_TARGET: LiqSpikeTarget = {
  family: 'tournament-results',
  titles: ['Supernova/2026/Ultimate/Singles Bracket'],
  why: 'test double: reuses the existing substantive bracket fixture to exercise the sufficient verdict.',
  discoverPrefix: 'Supernova/2026/Ultimate',
};

function buildFixtureBackedClient() {
  const fixtureFetch = createLiquipediaFixtureFetch([
    {
      match: matchQuery({ action: 'query', titles: STUB_BATCH_TARGET.titles.join('|') }),
      fixture: 'query-vodpages-stub-wikitext',
    },
    {
      match: matchQuery({ action: 'query', titles: SUBSTANTIVE_TARGET.titles.join('|') }),
      fixture: 'query-supernova-2026-singles-bracket',
    },
    {
      match: matchQuery({
        action: 'query',
        list: 'allpages',
        apprefix: 'Supernova/2026/Ultimate',
      }),
      fixture: 'query-allpages-supernova-prefix',
    },
  ]);

  const client = createLiquipediaClient({
    config: { contact: 'liq-spike-test@example.invalid' },
    // A pure test double, never the real RTDB-backed limiter — this test
    // exercises classification logic only, with zero network.
    limiter: {
      async acquire() {
        return { granted: true, waitedMs: 0 };
      },
    },
    fetchImpl: fixtureFetch.fetchImpl,
  });

  return { client, fixtureFetch };
}

describe('runLiqSpike', () => {
  it('classifies both shapes the corpus already contains, and a missing title as missing', async () => {
    const { client, fixtureFetch } = buildFixtureBackedClient();

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [
      STUB_BATCH_TARGET,
      SUBSTANTIVE_TARGET,
    ]);

    const byTitle = new Map(report.pages.map((page) => [page.title, page]));

    expect(byTitle.get('Hungrybox/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('Sparg0/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('MkLeo/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('IzAw/VODs')?.wikitextVerdict).toBe('missing');
    expect(byTitle.get('Supernova/2026/Ultimate/Singles Bracket')?.wikitextVerdict).toBe(
      'sufficient',
    );
    expect(
      byTitle.get('Supernova/2026/Ultimate/Singles Bracket')?.proposedAllowlistRegex,
    ).toBeUndefined();

    // Self-check: an empty run can never pass vacuously.
    expect(fixtureFetch.requests.length).toBeGreaterThan(0);

    expect(report.budget.parseClassRequests).toBe(0);
    expect(report.budget.generalRequests).toBe(fixtureFetch.requests.length);

    expect(report.discoveries).toHaveLength(1);
    expect(report.discoveries[0]).toMatchObject({
      family: 'tournament-results',
      prefix: 'Supernova/2026/Ultimate',
      discoveredCount: 2,
    });

    // Structural assertion: every request this run issued is action=query —
    // never a parse-class request.
    for (const url of fixtureFetch.requests) {
      expect(url.searchParams.get('action')).toBe('query');
    }
  });

  it('records a proposed anchored allowlist regex as a plain string for a stub-generator-only verdict', async () => {
    const { client } = buildFixtureBackedClient();

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [
      STUB_BATCH_TARGET,
    ]);

    const stub = report.pages.find((page) => page.title === 'Hungrybox/VODs');
    expect(typeof stub?.proposedAllowlistRegex).toBe('string');
    expect(stub?.proposedAllowlistRegex).toBe('^[^/]+/VODs$');
  });

  it('records the byte size and revision id of the returned page and the request-completion timestamp', async () => {
    const { client } = buildFixtureBackedClient();

    const report = await runLiqSpike({ client, now: () => 12345, log: () => undefined }, [
      SUBSTANTIVE_TARGET,
    ]);

    const page = report.pages.find(
      (candidate) => candidate.title === 'Supernova/2026/Ultimate/Singles Bracket',
    );
    expect(page?.revisionId).toBe(535578);
    expect(page?.byteSize).toBeGreaterThan(19_000);
    expect(page?.completedAtMs).toBe(12345);
  });
});

describe('assertSafeLiqSpikeOutPath (WR-03/D-28)', () => {
  const REPO_ROOT = '/repo';

  it('refuses a path that traverses outside the repo root', () => {
    expect(() =>
      assertSafeLiqSpikeOutPath({
        outPath: '../x.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).toThrow(UnsafeOutputPathError);
  });

  it('refuses a path that does not match the liq-spike-report naming pattern', () => {
    expect(() =>
      assertSafeLiqSpikeOutPath({
        outPath: 'apps/api/wrong-name.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).toThrow(/must match apps\/api\/liq-spike-report\*\.json/);
  });

  it('refuses a matching path that git reports as tracked (not ignored)', () => {
    expect(() =>
      assertSafeLiqSpikeOutPath({
        outPath: 'apps/api/liq-spike-report.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => false,
      }),
    ).toThrow(/not confirmed ignored by git/);
  });

  it('allows the happy path: matching name, confirmed ignored', () => {
    expect(() =>
      assertSafeLiqSpikeOutPath({
        outPath: 'apps/api/liq-spike-report.json',
        repoRoot: REPO_ROOT,
        isGitIgnored: () => true,
      }),
    ).not.toThrow();
  });

  it('happy path holds against the real repo .gitignore (no injected double)', () => {
    const realRepoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    expect(() =>
      assertSafeLiqSpikeOutPath({
        outPath: 'apps/api/liq-spike-report.json',
        repoRoot: realRepoRoot,
      }),
    ).not.toThrow();
  });
});

describe('LIQ_SPIKE_TARGETS', () => {
  it('names exactly three families with a nonzero, at-most-four title count each', () => {
    expect(LIQ_SPIKE_TARGETS).toHaveLength(3);
    for (const target of LIQ_SPIKE_TARGETS) {
      expect(target.titles.length).toBeGreaterThan(0);
      expect(target.titles.length).toBeLessThanOrEqual(4);
    }
    const families = new Set(LIQ_SPIKE_TARGETS.map((target) => target.family));
    expect(families).toEqual(
      new Set(['player-results', 'tournament-results', 'other-entrant-brackets']),
    );
  });
});
