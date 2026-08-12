import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type { ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { LIQUIPEDIA_PARSER_VERSION_VOD_LIST } from '@smash-tracker/shared';
import { WIKITEXT_PROBE_PARSER_VERSION } from './run.js';
import {
  attachResolvedObservation,
  readEnrichmentObservation,
  writeEnrichmentObservation,
  writeResolutionReceipt,
} from './store.js';
import { buildResolutionReceipt } from './resolution.js';
import { applyPageRefresh, planPageRefresh } from './refresh.js';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TENANT_ID = 'tenant-refresh-1';

function bracketObservation(
  overrides: Partial<ResearchEnrichmentObservationRecord> = {},
): ResearchEnrichmentObservationRecord {
  return {
    observationId: 'obs-1',
    sourceProvider: 'liquipedia',
    sourceWiki: 'smash',
    contentType: 'stage-observation',
    sourcePageTitle: 'TestCup/2026/Bracket',
    sourcePageUrl: 'https://liquipedia.net/smash/TestCup/2026/Bracket',
    sourceRevisionId: 20,
    sourceContentHash: sha256Hex('content-v1'),
    parserVersion: 'liquipedia-bracket-legacy@1',
    templateFamily: 'legacy',
    fetchedAtMs: 1_000,
    observedAtMs: 1_000,
    matchingStatus: 'unmatched',
    game: 'ultimate',
    tournamentPageTitle: 'TestCup/2026',
    tournamentStartggSlug: 'test-cup-2026',
    players: [{ rawTag: 'TestPlayer' }, { rawTag: 'OppTag' }],
    scores: [3, 1],
    date: '2026-01-01',
    games: [{ ordinal: 1, canonicalStageId: 5, rawStage: 'Battlefield' }],
    ...overrides,
  };
}

describe('planPageRefresh', () => {
  it('returns skip-before-fetch for an unchanged wikitext page and skip-after-fetch for an unchanged generated page, and never returns skip-before-fetch for the generated class', () => {
    const wikitextPlan = planPageRefresh({
      pageClass: 'wikitext',
      cached: {
        pageId: 'p1',
        title: 'Bracket',
        pageClass: 'wikitext',
        parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
        fetchedAtMs: 1,
        revisionId: 20,
        sha1: 'sha-v1',
      },
      probeRevisionId: 20,
      probeSha1: 'sha-v1',
      parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
    });
    expect(wikitextPlan.verdict).toBe('skip-before-fetch');

    const generatedPlan = planPageRefresh({
      pageClass: 'generated',
      cached: {
        pageId: 'p2',
        title: 'Player/VODs',
        pageClass: 'generated',
        parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
        fetchedAtMs: 1,
        contentHash: sha256Hex('rows-v1'),
      },
      fetchedContentHash: sha256Hex('rows-v1'),
      parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
    });
    expect(generatedPlan.verdict).toBe('skip-after-fetch');
    expect(generatedPlan.verdict).not.toBe('skip-before-fetch');

    // Structurally: the generated branch of planPageRefresh can NEVER
    // reach skip-before-fetch — proven by exhausting its verdict space.
    const generatedChangedPlan = planPageRefresh({
      pageClass: 'generated',
      cached: null,
      fetchedContentHash: sha256Hex('rows-v2'),
      parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
    });
    expect(generatedChangedPlan.verdict).not.toBe('skip-before-fetch');
  });

  it('a generated page with an unchanged revision id but a changed content hash IS refreshed', () => {
    const plan = planPageRefresh({
      pageClass: 'generated',
      cached: {
        pageId: 'p2',
        title: 'Player/VODs',
        pageClass: 'generated',
        parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
        fetchedAtMs: 1,
        contentHash: sha256Hex('rows-v1'),
        revisionId: 500, // deliberately unchanged
      },
      fetchedContentHash: sha256Hex('rows-v2'), // changed
      parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST,
    });
    expect(plan.verdict).toBe('refresh');
  });

  it('a bumped parser version alone forces re-extraction for both page classes', () => {
    const wikitextPlan = planPageRefresh({
      pageClass: 'wikitext',
      cached: {
        pageId: 'p1',
        title: 'Bracket',
        pageClass: 'wikitext',
        parserVersion: 'liquipedia-wikitext-probe@0', // old version
        fetchedAtMs: 1,
        revisionId: 20,
        sha1: 'sha-v1',
      },
      probeRevisionId: 20,
      probeSha1: 'sha-v1',
      parserVersion: WIKITEXT_PROBE_PARSER_VERSION, // bumped
    });
    expect(wikitextPlan.verdict).toBe('refresh');

    const generatedPlan = planPageRefresh({
      pageClass: 'generated',
      cached: {
        pageId: 'p2',
        title: 'Player/VODs',
        pageClass: 'generated',
        parserVersion: 'liquipedia-vodlist@0', // old version
        fetchedAtMs: 1,
        contentHash: sha256Hex('rows-v1'),
      },
      fetchedContentHash: sha256Hex('rows-v1'), // unchanged content
      parserVersion: LIQUIPEDIA_PARSER_VERSION_VOD_LIST, // bumped
    });
    expect(generatedPlan.verdict).toBe('refresh');
  });

  it('returns hold-for-review for a shrinking refresh, and refresh when allowShrink is set', () => {
    const held = planPageRefresh({
      pageClass: 'wikitext',
      cached: {
        pageId: 'p1',
        title: 'Bracket',
        pageClass: 'wikitext',
        parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
        fetchedAtMs: 1,
        revisionId: 20,
        sha1: 'sha-v1',
      },
      probeRevisionId: 21, // changed -> would refresh
      probeSha1: 'sha-v2',
      parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
      previousObservationCount: 5,
      nextObservationCount: 2,
    });
    expect(held.verdict).toBe('hold-for-review');

    const overridden = planPageRefresh({
      pageClass: 'wikitext',
      cached: {
        pageId: 'p1',
        title: 'Bracket',
        pageClass: 'wikitext',
        parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
        fetchedAtMs: 1,
        revisionId: 20,
        sha1: 'sha-v1',
      },
      probeRevisionId: 21,
      probeSha1: 'sha-v2',
      parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
      previousObservationCount: 5,
      nextObservationCount: 2,
      allowShrink: true,
    });
    expect(overridden.verdict).toBe('refresh');
  });
});

describe('applyPageRefresh', () => {
  it('a corrected stage updates exactly one game row and leaves every other stored enrichment for the page byte-unchanged', async () => {
    const database = new FakeDatabase();
    const untouched = bracketObservation({ observationId: 'obs-untouched', bracketKey: 'r1m2' });
    const original = bracketObservation({ observationId: 'obs-1', bracketKey: 'r1m1' });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, untouched);
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, original);

    const corrected = bracketObservation({
      observationId: 'obs-1',
      bracketKey: 'r1m1',
      games: [{ ordinal: 1, canonicalStageId: 9, rawStage: 'Pokemon Stadium 2' }],
    });

    const outcome = await applyPageRefresh(
      asDatabase(database),
      TENANT_ID,
      { verdict: 'refresh', reason: 'test' },
      { sourcePageTitle: 'TestCup/2026/Bracket', observations: [untouched, corrected] },
      2_000,
    );

    expect(outcome.written).toBe(1);
    expect(outcome.unchanged).toBe(1);

    const storedCorrected = await readEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
    );
    expect(storedCorrected?.games?.[0]?.rawStage).toBe('Pokemon Stadium 2');

    const storedUntouched = await readEnrichmentObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-untouched',
    );
    expect(storedUntouched).toEqual(untouched);
  });

  it('a shrinking refresh writes nothing, increments the shrink-held counter and creates a review entry', async () => {
    const database = new FakeDatabase();
    const first = bracketObservation({ observationId: 'obs-1' });
    const second = bracketObservation({ observationId: 'obs-2', bracketKey: 'r1m2' });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, first);
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, second);

    const plan = planPageRefresh({
      pageClass: 'wikitext',
      cached: null,
      probeRevisionId: 21,
      probeSha1: 'sha-v2',
      parserVersion: WIKITEXT_PROBE_PARSER_VERSION,
      previousObservationCount: 2,
      nextObservationCount: 1,
    });
    expect(plan.verdict).toBe('hold-for-review');

    const outcome = await applyPageRefresh(
      asDatabase(database),
      TENANT_ID,
      plan,
      { sourcePageTitle: 'TestCup/2026/Bracket', observations: [first] },
      3_000,
    );

    expect(outcome.verdict).toBe('hold-for-review');
    expect(outcome.written).toBe(0);
    expect(outcome.reviewEntryId).not.toBeNull();

    // Nothing overwritten: both prior observations are byte-unchanged.
    const storedFirst = await readEnrichmentObservation(asDatabase(database), TENANT_ID, 'obs-1');
    const storedSecond = await readEnrichmentObservation(asDatabase(database), TENANT_ID, 'obs-2');
    expect(storedFirst).toEqual(first);
    expect(storedSecond).toEqual(second);

    const reviewEntry = await database
      .ref(`researchEnrichmentShrinkReviews/${TENANT_ID}/${outcome.reviewEntryId}`)
      .get();
    expect(reviewEntry.exists()).toBe(true);
    const reviewValue = reviewEntry.val() as { previousCount: number; nextCount: number };
    expect(reviewValue.previousCount).toBe(2);
    expect(reviewValue.nextCount).toBe(1);
  });

  it('a user-owned VOD survives a correction', async () => {
    const database = new FakeDatabase();
    const matchKey = 'sgg-set-1-g1';
    await database
      .ref(`matches/${TENANT_ID}/${matchKey}`)
      .set({ vodUrl: 'https://www.youtube.com/watch?v=user-owned' });

    const original = bracketObservation({
      observationId: 'obs-1',
      vodUrl: 'https://www.youtube.com/watch?v=liquipedia-v1',
    });
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, original);

    const receipt = buildResolutionReceipt(
      original,
      { type: 'matched', targetSetId: 'set-1', confidence: 'high', evidence: [] },
      1_000,
    );
    if (!receipt) {
      throw new Error('test setup: expected a receipt');
    }
    await writeResolutionReceipt(asDatabase(database), TENANT_ID, receipt);
    await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      'obs-1',
      receipt.receiptId,
      1_000,
    );

    // The FIRST projection pass would have skipped the user-owned URL
    // already (fill-empty-only); simulate a LATER correction changing the
    // Liquipedia-side VOD URL.
    const corrected = bracketObservation({
      observationId: 'obs-1',
      vodUrl: 'https://www.youtube.com/watch?v=liquipedia-v2',
    });

    await applyPageRefresh(
      asDatabase(database),
      TENANT_ID,
      { verdict: 'refresh', reason: 'test' },
      { sourcePageTitle: 'TestCup/2026/Bracket', observations: [corrected] },
      4_000,
    );

    const row = await database.ref(`matches/${TENANT_ID}/${matchKey}`).get();
    expect((row.val() as { vodUrl?: string }).vodUrl).toBe(
      'https://www.youtube.com/watch?v=user-owned',
    );
  });
});
