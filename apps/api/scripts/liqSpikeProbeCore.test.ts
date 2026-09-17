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
  LIQ_SPIKE_FINGERPRINT_MAX_BYTES,
  LIQ_SPIKE_TARGETS,
  LiqSpikePartialRunError,
  assertSafeLiqSpikeOutPath,
  checkGeneralRequestStartSpacing,
  isSinglesBracketPageTitle,
  isTournamentEventPageTitle,
  runLiqSpike,
  type LiqSpikeTarget,
} from './liqSpikeProbeCore.js';

/**
 * Phase 36 Plan 07 (LIQ-01) — owner rerun incident fixes B, C, D. See
 * `liqSpikeProbeCore.ts`'s module doc comment for the full incident summary;
 * fix A's write-target regression tests live in `outputPathGuard.test.ts`
 * and `sparg0ExportCore.test.ts` (the shared guard both scripts use).
 */

// ---- fixture-corpus-backed tests (Stage 1: static player-results) --------

const STUB_BATCH_TARGET: LiqSpikeTarget = {
  family: 'player-results',
  titles: ['Hungrybox/VODs', 'Sparg0/VODs', 'MkLeo/VODs', 'IzAw/VODs'],
  why: 'test double: reuses the existing VODs-page stub fixture to exercise the stub-generator-only and missing verdicts.',
};

const SUBSTANTIVE_TARGET: LiqSpikeTarget = {
  family: 'player-results',
  titles: ['Supernova/2026/Ultimate/Singles Bracket'],
  why: 'test double: reuses the existing substantive bracket fixture to exercise the sufficient verdict.',
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
  ]);

  const client = createLiquipediaClient({
    config: { contact: 'liq-spike-test@example.invalid' },
    limiter: {
      async acquire() {
        return { granted: true, waitedMs: 0 };
      },
    },
    fetchImpl: fixtureFetch.fetchImpl,
  });

  return { client, fixtureFetch };
}

describe('runLiqSpike — Stage 1 (static player-results titles)', () => {
  it('classifies both shapes the corpus already contains, and a missing title as missing', async () => {
    const { client, fixtureFetch } = buildFixtureBackedClient();

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [STUB_BATCH_TARGET, SUBSTANTIVE_TARGET],
      { seedPrefixes: [] },
    );

    const byTitle = new Map(report.pages.map((page) => [page.title, page]));

    expect(byTitle.get('Hungrybox/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('Sparg0/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('MkLeo/VODs')?.wikitextVerdict).toBe('stub-generator-only');
    expect(byTitle.get('IzAw/VODs')?.wikitextVerdict).toBe('missing');
    expect(byTitle.get('Supernova/2026/Ultimate/Singles Bracket')?.wikitextVerdict).toBe(
      'sufficient',
    );

    expect(fixtureFetch.requests.length).toBeGreaterThan(0);
    expect(report.budget.parseClassRequests).toBe(0);
    expect(report.budget.generalRequests).toBe(fixtureFetch.requests.length);

    for (const url of fixtureFetch.requests) {
      expect(url.searchParams.get('action')).toBe('query');
    }
  });

  it('records a proposed anchored allowlist regex as a plain string for a stub-generator-only verdict', async () => {
    const { client } = buildFixtureBackedClient();

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [STUB_BATCH_TARGET],
      { seedPrefixes: [] },
    );

    const stub = report.pages.find((page) => page.title === 'Hungrybox/VODs');
    expect(typeof stub?.proposedAllowlistRegex).toBe('string');
    expect(stub?.proposedAllowlistRegex).toBe('^[^/]+/VODs$');
  });

  it('records the byte size and revision id of the returned page and the request-completion timestamp', async () => {
    const { client } = buildFixtureBackedClient();

    const report = await runLiqSpike(
      { client, now: () => 12345, log: () => undefined },
      [SUBSTANTIVE_TARGET],
      { seedPrefixes: [] },
    );

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

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

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

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

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

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

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

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    expect(report.pages[0]?.wikitextVerdict).toBe('sufficient');
    expect(report.pages[0]?.proposedAllowlistRegex).toBeUndefined();
  });

  // Fix 2 (owner rerun #2): the fix-C classifier ("every line is a solitary
  // template") was ITSELF still a guess — it only recognized a template
  // followed by MORE templates, missing the equally-non-substantive shape
  // of a template followed by a category link. Structural stripping
  // (strip templates AND categories, then check what's left) catches this
  // shape the line-pattern check could not.
  it('classifies a template followed by a category link as stub-generator-only (a shape the old line-pattern check missed)', async () => {
    const templateThenCategory = '{{Infobox player results}}\n[[Category:Players]]';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['CategoryStub/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'CategoryStub/Results' }),
        body: queryEnvelope([
          { title: 'CategoryStub/Results', revid: 5, content: templateThenCategory },
        ]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    expect(report.pages[0]?.wikitextVerdict).toBe('stub-generator-only');
  });

  it('classifies simply-nested templates as stub-generator-only (iterative stripping)', async () => {
    const nestedTemplateOnly = '{{Infobox player results|note={{small|active}}}}';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['NestedStub/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'NestedStub/Results' }),
        body: queryEnvelope([
          { title: 'NestedStub/Results', revid: 6, content: nestedTemplateOnly },
        ]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    expect(report.pages[0]?.wikitextVerdict).toBe('stub-generator-only');
  });

  it('does not strip genuine table/list markup — a table-only body (post-template-strip) is sufficient', async () => {
    const tableBody = '{{Infobox player results}}\n{|\n|Genesis 9||1st\n|}';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['TableBody/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'TableBody/Results' }),
        body: queryEnvelope([{ title: 'TableBody/Results', revid: 7, content: tableBody }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    expect(report.pages[0]?.wikitextVerdict).toBe('sufficient');
  });
});

describe('LiqSpikePageResult fingerprint / rawWikitext (fix 2)', () => {
  it('attaches a leak-free fingerprint and the raw wikitext for a page under the fingerprint size threshold', async () => {
    const shortTemplateOnly = '{{Infobox player results}}';
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['ShortStub/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'ShortStub/Results' }),
        body: queryEnvelope([{ title: 'ShortStub/Results', revid: 8, content: shortTemplateOnly }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    const page = report.pages[0];
    expect(page?.rawWikitext).toBe(shortTemplateOnly);
    expect(page?.fingerprint).toEqual({
      templateOpenCount: 1,
      internalLinkOpenCount: 0,
      pipeCount: 0,
      lineCount: 1,
      startsWithRedirect: false,
      firstTemplateName: 'Infobox player results',
    });
  });

  it('omits the fingerprint for a page at or above the fingerprint size threshold, but still attaches rawWikitext', async () => {
    const longBody = 'x'.repeat(LIQ_SPIKE_FINGERPRINT_MAX_BYTES + 10);
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['LongBody/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'LongBody/Results' }),
        body: queryEnvelope([{ title: 'LongBody/Results', revid: 9, content: longBody }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    const page = report.pages[0];
    expect(page?.fingerprint).toBeUndefined();
    expect(page?.rawWikitext).toBe(longBody);
  });

  it('never attaches rawWikitext/fingerprint for a missing page', async () => {
    const target: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['Nope/Results'],
      why: 'test',
    };
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'Nope/Results' }),
        body: queryEnvelope([{ title: 'Nope/Results', missing: true }]),
      },
    ]);

    const report = await runLiqSpike({ client, now: () => 0, log: () => undefined }, [target], {
      seedPrefixes: [],
    });

    const page = report.pages[0];
    expect(page?.wikitextVerdict).toBe('missing');
    expect(page?.rawWikitext).toBeUndefined();
    expect(page?.fingerprint).toBeUndefined();
  });
});

// ---- isTournamentEventPageTitle / isSinglesBracketPageTitle (pure) --------

describe('isTournamentEventPageTitle / isSinglesBracketPageTitle', () => {
  it('accepts a tournament event page and rejects its own bracket subpage', () => {
    expect(isTournamentEventPageTitle('Genesis 9/Ultimate')).toBe(true);
    expect(isTournamentEventPageTitle('Genesis 9/Ultimate/Singles Bracket')).toBe(false);
    expect(isTournamentEventPageTitle('Genesis 9/Melee')).toBe(false);
  });

  it('accepts a singles-bracket subpage and rejects the event page itself', () => {
    expect(isSinglesBracketPageTitle('Genesis 9/Ultimate/Singles Bracket')).toBe(true);
    expect(isSinglesBracketPageTitle('Genesis 9/Ultimate')).toBe(false);
    expect(isSinglesBracketPageTitle('Genesis 9/Ultimate/Doubles Bracket')).toBe(false);
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
    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [STUB_BATCH_TARGET],
      { seedPrefixes: [] },
    );
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
          // A single Stage-1 fetch only issues ONE request, so a real run
          // could never observe two starts from it alone — this directly
          // exercises the check with an INJECTED violating pair, exactly as
          // "fake clock" testing means here: synthetic start timestamps, not
          // timer mocking.
          generalRequestStartTimestampsMs: [1000, 1500],
        },
        [STUB_BATCH_TARGET],
        { seedPrefixes: [] },
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
      { seedPrefixes: [] },
    );
    expect(report.budget.minObservedGeneralStartSpacingMs).toBe(LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS);
  });
});

// ---- partial report on any failure (fix 4) ---------------------------------

describe('runLiqSpike — partial report on failure (fix 4)', () => {
  it('rejects with LiqSpikePartialRunError carrying already-fetched pages when a later fetch throws', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['Hungrybox/Results'],
      why: 'test',
    };
    // Only the player-results route is registered — the tournament-results
    // discovery call that follows has no registered route and throws,
    // simulating a network failure mid-run.
    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'Hungrybox/Results' }),
        body: queryEnvelope([
          { title: 'Hungrybox/Results', revid: 10, content: 'Prose with no links at all.' },
        ]),
      },
    ]);

    let caught: unknown;
    try {
      await runLiqSpike({ client, now: () => 0, log: () => undefined }, [playerResultsTarget], {
        seedPrefixes: ['Genesis'],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LiqSpikePartialRunError);
    const partialError = caught as LiqSpikePartialRunError;
    expect(partialError.message).toMatch(/no registered route matches/);
    // The Stage-1 page fetched BEFORE the failure is preserved.
    expect(partialError.partialReport.pages).toHaveLength(1);
    expect(partialError.partialReport.pages[0]?.title).toBe('Hungrybox/Results');
    expect(partialError.partialReport.familyOutcomes).toEqual([
      { family: 'player-results', status: 'sampled', sampledTitles: ['Hungrybox/Results'] },
    ]);
    expect(partialError.partialReport.budget.generalRequests).toBe(1);
  });

  it('carries the pages fetched before a genuine spacing violation in the partial report', async () => {
    const { client } = buildFixtureBackedClient();

    let caught: unknown;
    try {
      await runLiqSpike(
        {
          client,
          now: () => 0,
          log: () => undefined,
          generalRequestStartTimestampsMs: [1000, 1500],
        },
        [STUB_BATCH_TARGET],
        { seedPrefixes: [] },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LiqSpikePartialRunError);
    const partialError = caught as LiqSpikePartialRunError;
    expect(partialError.message).toMatch(/general-class request start spacing violated/);
    // Stage 1 fully completed before the spacing check runs (it runs once,
    // at the very end), so all four VODs-page results are preserved.
    expect(partialError.partialReport.pages.length).toBeGreaterThan(0);
  });
});

// ---- discovery cascade (fix D, budget-governed per fix 3) ------------------

describe('runLiqSpike — discovery cascade for tournament-results / other-entrant-brackets (fix D / fix 3)', () => {
  it('discovers real titles via list=allpages, cascading from series-name prefixes to the discovered event page, never guessing and never following player-page links', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['Hungrybox/Results'],
      why: 'test',
    };
    // Deliberately contains a real internal link — proves fix 3's
    // retraction: this link is NEVER followed for discovery seeding
    // (only LIQ_SPIKE_SERIES_PREFIX_SEEDS / the explicit seedPrefixes
    // override below are ever tried as discovery prefixes).
    const hungryboxContent =
      'Notable placements include [[Genesis 9/Ultimate|Genesis 9]] and other majors.';

    const { client, requests } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'Hungrybox/Results' }),
        body: queryEnvelope([{ title: 'Hungrybox/Results', revid: 10, content: hungryboxContent }]),
      },
      {
        match: matchQuery({ action: 'query', list: 'allpages', apprefix: 'Genesis' }),
        body: {
          query: {
            allpages: [
              { pageid: 1, title: 'Genesis 9/Ultimate' },
              { pageid: 2, title: 'Genesis 9/Ultimate/Singles Bracket' },
              { pageid: 3, title: 'Genesis 9/Melee' },
            ],
          },
        },
      },
      {
        match: matchQuery({ action: 'query', titles: 'Genesis 9/Ultimate' }),
        body: queryEnvelope([
          {
            title: 'Genesis 9/Ultimate',
            revid: 20,
            content: 'A major SSBU tournament held annually in California.',
          },
        ]),
      },
      {
        match: matchQuery({ action: 'query', list: 'allpages', apprefix: 'Genesis 9/Ultimate' }),
        body: {
          query: {
            allpages: [
              { pageid: 2, title: 'Genesis 9/Ultimate/Singles Bracket' },
              { pageid: 4, title: 'Genesis 9/Ultimate/Doubles Bracket' },
            ],
          },
        },
      },
      {
        match: matchQuery({ action: 'query', titles: 'Genesis 9/Ultimate/Singles Bracket' }),
        body: queryEnvelope([
          {
            title: 'Genesis 9/Ultimate/Singles Bracket',
            revid: 30,
            content: 'A full double-elimination bracket of named entrants and their placements.',
          },
        ]),
      },
    ]);

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [playerResultsTarget],
      { seedPrefixes: ['Genesis'] },
    );

    const byTitle = new Map(report.pages.map((page) => [page.title, page]));
    expect(byTitle.get('Genesis 9/Ultimate')?.wikitextVerdict).toBe('sufficient');
    expect(byTitle.get('Genesis 9/Ultimate/Singles Bracket')?.wikitextVerdict).toBe('sufficient');

    const tournamentDiscovery = report.discoveries.find(
      (d) => d.family === 'tournament-results' && d.prefix === 'Genesis',
    );
    expect(tournamentDiscovery?.discoveredCount).toBe(3);
    expect(tournamentDiscovery?.acceptedTitles).toEqual(['Genesis 9/Ultimate']);

    const bracketDiscovery = report.discoveries.find(
      (d) => d.family === 'other-entrant-brackets' && d.prefix === 'Genesis 9/Ultimate',
    );
    expect(bracketDiscovery?.discoveredCount).toBe(2);
    expect(bracketDiscovery?.acceptedTitles).toEqual(['Genesis 9/Ultimate/Singles Bracket']);

    // Every request this run issued is action=query — never a parse-class request.
    for (const url of requests) {
      expect(url.searchParams.get('action')).toBe('query');
    }
    expect(report.budget.generalRequests).toBe(requests.length);
    // 1 (Hungrybox/Results) + 1 (discover under "Genesis") + 1 (Genesis
    // 9/Ultimate wikitext) + 1 (discover brackets under "Genesis
    // 9/Ultimate") + 1 (bracket wikitext) = 5. The link inside
    // Hungrybox/Results is never tried as its own discovery prefix
    // (fix 3) — only the explicit seedPrefixes override is.
    expect(report.budget.generalRequests).toBe(5);

    expect(report.familyOutcomes).toEqual([
      {
        family: 'player-results',
        status: 'sampled',
        sampledTitles: ['Hungrybox/Results'],
      },
      {
        family: 'tournament-results',
        status: 'sampled',
        sampledTitles: ['Genesis 9/Ultimate'],
      },
      {
        family: 'other-entrant-brackets',
        status: 'sampled',
        sampledTitles: ['Genesis 9/Ultimate/Singles Bracket'],
      },
    ]);
  });

  it('logs plainly and produces no page entries for a family when discovery finds nothing', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['IzAw/Results'],
      why: 'test',
    };
    const logLines: string[] = [];

    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'IzAw/Results' }),
        body: queryEnvelope([{ title: 'IzAw/Results', missing: true }]),
      },
      {
        match: matchQuery({ action: 'query', list: 'allpages', apprefix: 'NoSuchSeries' }),
        body: { query: { allpages: [] } },
      },
    ]);

    const report = await runLiqSpike(
      { client, now: () => 0, log: (line) => logLines.push(line) },
      [playerResultsTarget],
      { seedPrefixes: ['NoSuchSeries'] },
    );

    expect(report.pages.filter((p) => p.family === 'tournament-results')).toHaveLength(0);
    expect(report.pages.filter((p) => p.family === 'other-entrant-brackets')).toHaveLength(0);
    expect(logLines.some((line) => line.includes('[tournament-results] not-sampled:'))).toBe(true);
    expect(logLines.some((line) => line.includes('[other-entrant-brackets] not-sampled:'))).toBe(
      true,
    );

    const tournamentOutcome = report.familyOutcomes.find((o) => o.family === 'tournament-results');
    expect(tournamentOutcome).toEqual({
      family: 'tournament-results',
      status: 'not-sampled',
      reason: 'no matching titles discovered among 1 prefix(es) tried',
      sampledTitles: [],
    });
    const bracketOutcome = report.familyOutcomes.find((o) => o.family === 'other-entrant-brackets');
    expect(bracketOutcome).toEqual({
      family: 'other-entrant-brackets',
      status: 'not-sampled',
      reason: 'no matching titles discovered among 0 tournament event page(s) tried',
      sampledTitles: [],
    });
  });

  it('stops issuing further requests once the general-request budget is exhausted, and records budgetExhausted', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['Hungrybox/Results'],
      why: 'test',
    };

    const { client, requests } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'Hungrybox/Results' }),
        body: queryEnvelope([
          { title: 'Hungrybox/Results', revid: 10, content: 'Prose with no links at all.' },
        ]),
      },
      {
        match: matchQuery({ action: 'query', list: 'allpages', apprefix: 'Genesis' }),
        body: { query: { allpages: [{ pageid: 1, title: 'Genesis 9/Ultimate' }] } },
      },
    ]);

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [playerResultsTarget],
      { seedPrefixes: ['Genesis'], maxGeneralRequests: 2 },
    );

    // Budget covers exactly: player-results (1) + the Genesis discovery
    // call (1) = 2. The tournament-results wikitext fetch that would
    // otherwise follow never fires.
    expect(requests.length).toBe(2);
    expect(report.budget.generalRequests).toBe(2);
    expect(report.budget.budgetExhausted).toBe(true);
    expect(report.pages.filter((p) => p.family === 'tournament-results')).toHaveLength(0);

    const tournamentOutcome = report.familyOutcomes.find((o) => o.family === 'tournament-results');
    expect(tournamentOutcome?.status).toBe('not-sampled');
    expect(tournamentOutcome?.reason).toBe('budget');
  });

  // Fix 3's core requirement: a family whose discovery attempts all come up
  // empty must NEVER be allowed to keep spending general-request budget
  // indefinitely — its OWN reserved discovery allotment
  // (LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS) caps it, protecting whatever
  // budget the run has left for the NEXT stage (a real regression: fix D's
  // link-following spent the ENTIRE 20-request cap chasing dead prefixes).
  it('caps tournament-results discovery at its own reserved budget, never spending the whole run on one family', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['Hungrybox/Results'],
      why: 'test',
    };
    const deadSeedPrefixes = ['Dead1', 'Dead2', 'Dead3', 'Dead4', 'Dead5', 'Dead6', 'Dead7'];

    const { client, requests } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'Hungrybox/Results' }),
        body: queryEnvelope([
          { title: 'Hungrybox/Results', revid: 10, content: 'Prose with no links at all.' },
        ]),
      },
      ...deadSeedPrefixes.map((prefix) => ({
        match: matchQuery({ action: 'query', list: 'allpages', apprefix: prefix }),
        body: { query: { allpages: [] } },
      })),
    ]);

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [playerResultsTarget],
      { seedPrefixes: deadSeedPrefixes, maxGeneralRequests: 20 },
    );

    // 1 (player-results) + exactly LIQ_SPIKE_RESERVED_DISCOVERY_REQUESTS
    // (5) discovery attempts, NEVER all 7 dead prefixes — the reserved
    // per-family cap binds well before the global 20-request cap would.
    expect(requests.length).toBe(6);
    expect(report.budget.generalRequests).toBe(6);
    expect(report.budget.budgetExhausted).toBe(false);

    const tournamentOutcome = report.familyOutcomes.find((o) => o.family === 'tournament-results');
    expect(tournamentOutcome).toEqual({
      family: 'tournament-results',
      status: 'not-sampled',
      reason: 'no matching titles discovered among 5 prefix(es) tried',
      sampledTitles: [],
    });
  });

  it('surfaces normalized/redirected titles the API itself reports, without any guessed alternate spelling', async () => {
    const playerResultsTarget: LiqSpikeTarget = {
      family: 'player-results',
      titles: ['MkLeo/Results'],
      why: 'test',
    };

    const { client } = buildInlineClient([
      {
        match: matchQuery({ action: 'query', titles: 'MkLeo/Results' }),
        body: {
          query: {
            normalized: [{ from: 'MkLeo/Results', to: 'MKLeo/Results' }],
            redirects: [{ from: 'MKLeo/Results', to: 'MKLeo (player)/Results' }],
            pages: [
              {
                title: 'MKLeo (player)/Results',
                revisions: [
                  {
                    revid: 40,
                    parentid: 0,
                    timestamp: '2026-01-01T00:00:00Z',
                    slots: { main: { content: 'Genuine placement history prose.' } },
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    const report = await runLiqSpike(
      { client, now: () => 0, log: () => undefined },
      [playerResultsTarget],
      { seedPrefixes: [] },
    );

    expect(report.normalizations).toEqual([
      { family: 'player-results', from: 'MkLeo/Results', to: 'MKLeo/Results' },
    ]);
    expect(report.redirectsFollowed).toEqual([
      { family: 'player-results', from: 'MKLeo/Results', to: 'MKLeo (player)/Results' },
    ]);
  });
});

// ---- LIQ_SPIKE_TARGETS ------------------------------------------------------

describe('LIQ_SPIKE_TARGETS', () => {
  it('names only the static player-results family, with a nonzero, at-most-four title count', () => {
    expect(LIQ_SPIKE_TARGETS).toHaveLength(1);
    expect(LIQ_SPIKE_TARGETS[0]?.family).toBe('player-results');
    expect(LIQ_SPIKE_TARGETS[0]?.titles.length).toBeGreaterThan(0);
    expect(LIQ_SPIKE_TARGETS[0]?.titles.length).toBeLessThanOrEqual(4);
  });
});

// ---- assertSafeLiqSpikeOutPath (WR-03/D-28) --------------------------------

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
