import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLiquipediaClient } from '../src/liquipedia/client.js';
import {
  createLiquipediaFixtureFetch,
  matchQuery,
  type LiquipediaFixtureRouteMatch,
} from '../src/liquipedia/__fixtures__/loadFixture.js';
import { LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS } from '../src/liquipedia/limiter.js';
import { UnsafeOutputPathError } from './outputPathGuard.js';
import {
  LIQ_SPIKE_TARGETS,
  runLiqSpike,
  assertSafeLiqSpikeOutPath,
  checkGeneralRequestStartSpacing,
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

// ---- classification is structural, never byte-gated (fix C) --------------

/** A synthetic in-memory MediaWiki `action=query` fetch — for shapes that do not exist in the committed fixture corpus (there is no live network access to capture real bytes for; every body below is a mechanically-constructed, clearly-synthetic `{{...}}`/`#REDIRECT` shape, never invented prose). */
function createInlineLiquipediaFetch(
  routes: { match: LiquipediaFixtureRouteMatch; body: unknown }[],
): { fetchImpl: typeof fetch; requests: URL[] } {
  const requests: URL[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    requests.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`createInlineLiquipediaFetch: no registered route matches "${rawUrl}"`);
    }
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function buildInlineClient(routes: { match: LiquipediaFixtureRouteMatch; body: unknown }[]) {
  const { fetchImpl, requests } = createInlineLiquipediaFetch(routes);
  const client = createLiquipediaClient({
    config: { contact: 'liq-spike-test@example.invalid' },
    limiter: {
      async acquire() {
        return { granted: true, waitedMs: 0 };
      },
    },
    fetchImpl,
  });
  return { client, requests };
}

/** A synthetic query envelope shaped exactly like `RawQueryEnvelope` in client.ts. */
function queryEnvelope(
  pages: { title: string; missing?: true; revid?: number; content?: string }[],
) {
  return {
    query: {
      pages: pages.map((page) =>
        page.missing
          ? { title: page.title, missing: true }
          : {
              title: page.title,
              revisions: [
                {
                  revid: page.revid,
                  parentid: 0,
                  timestamp: '2026-01-01T00:00:00Z',
                  slots: { main: { content: page.content ?? '' } },
                },
              ],
            },
      ),
    },
  };
}

describe('classifyWikitext (via runLiqSpike) — structural, not byte-gated (fix C)', () => {
  it('classifies a LONG template-only body as stub-generator-only (byte count alone must never make it sufficient)', async () => {
    // 20 template calls — comfortably over the old 200-byte threshold, and
    // proves the fix: the OLD code would have called this "sufficient"
    // purely because it is long, exactly the defect the owner's first live
    // run surfaced at 245/248 bytes.
    const longTemplateOnly = Array.from(
      { length: 20 },
      (_, i) => `{{Template call number ${i}}}`,
    ).join('\n');
    expect(longTemplateOnly.length).toBeGreaterThan(200);

    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['LongStub/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'LongStub/Results' }),
        body: queryEnvelope([{ title: 'LongStub/Results', revid: 1, content: longTemplateOnly }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target]);

    expect(report.pages[0]?.wikitextVerdict).toBe('stub-generator-only');
    expect(report.pages[0]?.proposedAllowlistRegex).toBe('^[^/]+/Results$');
  });

  it('classifies a SHORT template-only body (the real 245/248-byte shape) as stub-generator-only', async () => {
    const shortTemplateOnly = '{{Infobox player results}}';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['ShortStub/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'ShortStub/Results' }),
        body: queryEnvelope([{ title: 'ShortStub/Results', revid: 2, content: shortTemplateOnly }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target]);

    expect(report.pages[0]?.wikitextVerdict).toBe('stub-generator-only');
  });

  it('classifies a bare #REDIRECT declaration as stub-generator-only, with a trailing category still non-substantive', async () => {
    const redirectOnly = '#REDIRECT [[MKLeo/Results]]\n[[Category:Redirects]]';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['MkLeo/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'MkLeo/Results' }),
        body: queryEnvelope([{ title: 'MkLeo/Results', revid: 3, content: redirectOnly }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target]);

    expect(report.pages[0]?.wikitextVerdict).toBe('stub-generator-only');
  });

  it('classifies a SHORT genuine-prose body as sufficient (short is not the same as generator-only)', async () => {
    const shortProse = 'No competitive results are currently recorded for this player.';
    expect(shortProse.length).toBeLessThan(200);
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['NewPlayer/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'NewPlayer/Results' }),
        body: queryEnvelope([{ title: 'NewPlayer/Results', revid: 4, content: shortProse }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target]);

    expect(report.pages[0]?.wikitextVerdict).toBe('sufficient');
    expect(report.pages[0]?.proposedAllowlistRegex).toBeUndefined();
  });
});

// ---- checkGeneralRequestStartSpacing (pure, fake clock) -------------------

describe('checkGeneralRequestStartSpacing', () => {
  it('is trivially compliant with fewer than two timestamps', () => {
    expect(checkGeneralRequestStartSpacing([])).toEqual({
      minObservedStartSpacingMs: null,
      compliant: true,
    });
    expect(checkGeneralRequestStartSpacing([1000])).toEqual({
      minObservedStartSpacingMs: null,
      compliant: true,
    });
  });

  it('is compliant when every consecutive gap meets the minimum interval', () => {
    const result = checkGeneralRequestStartSpacing([0, 2000, 4000, 6000], 2000);
    expect(result.compliant).toBe(true);
    expect(result.minObservedStartSpacingMs).toBe(2000);
    expect(result.violation).toBeUndefined();
  });

  it('is non-compliant and names the violating pair when a gap is too small', () => {
    const result = checkGeneralRequestStartSpacing([0, 2000, 2100, 4200], 2000);
    expect(result.compliant).toBe(false);
    expect(result.minObservedStartSpacingMs).toBe(100);
    expect(result.violation).toEqual({ indexA: 1, indexB: 2, gapMs: 100 });
  });

  it('defaults its minimum interval to the shipped LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS constant', () => {
    const justUnder = checkGeneralRequestStartSpacing([0, LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS - 1]);
    expect(justUnder.compliant).toBe(false);
    const exact = checkGeneralRequestStartSpacing([0, LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS]);
    expect(exact.compliant).toBe(true);
  });
});

describe('runLiqSpike — general-class start-spacing enforcement (fix B)', () => {
  it('does not throw and reports null start-spacing fields when no start timestamps are supplied', async () => {
    const { client } = buildFixtureBackedClient();
    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [
      STUB_BATCH_TARGET,
    ]);
    expect(report.budget.minObservedGeneralStartSpacingMs).toBeNull();
  });

  it('throws loudly when two general-class request starts are closer than the published minimum interval', async () => {
    const { client } = buildFixtureBackedClient();
    await expect(
      runLiqSpike(
        {
          client,
          now: () => 0,
          log: () => undefined,
          // A single fetch only issues ONE request, so a real run could
          // never observe two starts from it alone — this directly
          // exercises the check with INJECTED synthetic start timestamps
          // ("fake clock" here means synthetic timestamps, not timer
          // mocking).
          generalRequestStartTimestampsMs: [1000, 1500],
        },
        [STUB_BATCH_TARGET],
      ),
    ).rejects.toThrow(/general-class request start spacing violated/);
  });

  it('does not throw when injected start timestamps are compliant', async () => {
    const { client } = buildFixtureBackedClient();
    const report = await runLiqSpike(
      {
        client,
        now: () => 0,
        log: () => undefined,
        generalRequestStartTimestampsMs: [1000, 1000 + LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS],
      },
      [STUB_BATCH_TARGET],
    );
    expect(report.budget.minObservedGeneralStartSpacingMs).toBe(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
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

  // WR-04-i2: the wildcard segment must not cross a `/` — gitignore's `*`
  // glob never crosses directory boundaries, so a nested path like this one
  // is genuinely NOT covered by the .gitignore rule the docstring claims is
  // "the exact glob", even though the pre-fix regex's `.*` wildcard matched
  // it. Uses a real fixture directory so the WR-03-i2 filesystem-safety
  // check isn't what rejects this path — the pattern check must be.
  it('refuses a nested path even though it starts with the allowed filename prefix', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
    mkdirSync(path.join(root, 'apps', 'api', 'liq-spike-report-dir'), { recursive: true });
    try {
      expect(() =>
        assertSafeLiqSpikeOutPath({
          outPath: 'apps/api/liq-spike-report-dir/evil.json',
          repoRoot: root,
          isGitIgnored: () => true,
        }),
      ).toThrow(/must match apps\/api\/liq-spike-report\*\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WR-03-i2: the filesystem-target safety check (`lstat`/`realpath`) touches
  // real disk, so these two tests (which exercise code past the pattern
  // check) need a repo root that genuinely exists on disk — a fake `/repo`
  // string now fails closed with a filesystem-resolution error first.
  it('refuses a matching path that git reports as tracked (not ignored)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
    mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
    try {
      expect(() =>
        assertSafeLiqSpikeOutPath({
          outPath: 'apps/api/liq-spike-report.json',
          repoRoot: root,
          isGitIgnored: () => false,
        }),
      ).toThrow(/not confirmed ignored by git/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows the happy path: matching name, confirmed ignored — and returns the resolved absolute path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
    mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
    try {
      const resolved = assertSafeLiqSpikeOutPath({
        outPath: 'apps/api/liq-spike-report.json',
        repoRoot: root,
        isGitIgnored: () => true,
      });
      expect(resolved).toBe(path.join(root, 'apps', 'api', 'liq-spike-report.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  // Fix A regression: the owner's first live run validated the correct
  // repo-root-relative resolution here, then `liqSpikeProbe.ts` separately
  // called `writeFile(outPath, ...)` with the raw `--out` string — which
  // `fs.writeFile` resolves against `process.cwd()`, not `repoRoot`. `pnpm
  // --filter <pkg> exec` sets `cwd` to `apps/api/`, so that second
  // resolution silently targeted `apps/api/apps/api/liq-spike-report.json`,
  // which does not exist, and the write failed with ENOENT after the run
  // had already spent its Liquipedia request budget. `liqSpikeProbe.ts`'s
  // `main()` now writes to the value THIS function returns, never to a
  // second resolution of `outPath`.
  describe('write-target resolution (fix A regression)', () => {
    it('resolves the write target from repoRoot, independent of process.cwd()', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
      const apiDir = path.join(root, 'apps', 'api');
      mkdirSync(apiDir, { recursive: true });
      const originalCwd = process.cwd();
      try {
        // Simulate `pnpm --filter @smash-tracker/api exec` setting cwd to
        // apps/api/ — the exact condition under which a second, independent
        // resolution of the same relative --out string diverged from the
        // one validated here.
        process.chdir(apiDir);
        const resolved = assertSafeLiqSpikeOutPath({
          outPath: 'apps/api/liq-spike-report.json',
          repoRoot: root,
          isGitIgnored: () => true,
        });
        expect(resolved).toBe(path.join(root, 'apps', 'api', 'liq-spike-report.json'));
      } finally {
        process.chdir(originalCwd);
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('resolves an absolute --out inside apps/api/ to itself', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
      mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
      try {
        const absoluteOut = path.join(root, 'apps', 'api', 'liq-spike-report.json');
        const resolved = assertSafeLiqSpikeOutPath({
          outPath: absoluteOut,
          repoRoot: root,
          isGitIgnored: () => true,
        });
        expect(resolved).toBe(absoluteOut);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('still refuses an absolute --out outside the repo', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'liq-spike-probe-core-'));
      mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
      try {
        expect(() =>
          assertSafeLiqSpikeOutPath({
            outPath: '/etc/passwd',
            repoRoot: root,
            isGitIgnored: () => true,
          }),
        ).toThrow(UnsafeOutputPathError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
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
