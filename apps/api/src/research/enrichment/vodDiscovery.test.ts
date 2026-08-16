import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import type {
  ResearchEnrichmentVodCandidateRecord,
  ResearchSourceSetRecord,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../../test-support/fakeDatabase.js';
import { deriveEnrichmentMatchRowKey, applyEnrichmentProjection } from './projection.js';
import {
  buildVodDiscoveryQuery,
  confirmVodCandidateByAdmin,
  dismissVodCandidateByAdmin,
  listConfirmedVodCandidatesForSet,
  listVodCandidatesForTenant,
  readConfirmedCandidateVodForSet,
  runVodCandidateDiscovery,
  scoreVodCandidate,
  selectVodDiscoveryTargets,
  VOD_DISCOVERY_MAX_RESULTS_PER_SET,
  VOD_DISCOVERY_MAX_SETS_PER_RUN,
  writeVodCandidate,
} from './vodDiscovery.js';

const TENANT_ID = 'tenant-vod';

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function makeCandidate(
  overrides: Partial<ResearchEnrichmentVodCandidateRecord> = {},
): ResearchEnrichmentVodCandidateRecord {
  return {
    candidateId: 'yt-abc123',
    targetSetId: 'set-1',
    provider: 'youtube-data-api',
    query: 'Supernova 2026 Sparg0 vs MkLeo Grand Final',
    videoId: 'abc123',
    videoUrl: 'https://www.youtube.com/watch?v=abc123',
    title: 'Sparg0 vs MkLeo - Grand Final - Supernova 2026',
    fetchedAtMs: 1000,
    score: 4,
    status: 'proposed',
    ...overrides,
  };
}

function makeSourceSet(
  storageKey: string,
  overrides: Partial<ResearchSourceSetRecord> = {},
): ResearchSourceSetRecord {
  return {
    providerSetId: storageKey,
    storageKey,
    classification: 'complete',
    ruleId: 'rule-1',
    completedAt: 1_700_000_000,
    fullRoundText: 'Grand Final',
    event: { name: 'Ultimate Singles', tournamentName: 'Supernova 2026' },
    entrants: [
      { entrantId: 'e1', name: 'Sparg0' },
      { entrantId: 'e2', name: 'MkLeo' },
    ],
    projectedMatchKeys: [deriveEnrichmentMatchRowKey(storageKey, 1)],
    apiIds: { setId: storageKey },
    ingestionRunId: 'run-1',
    fetchedAtMs: 1000,
    lastObservedAtMs: 1000,
    ...overrides,
  };
}

function seedSetWithRow(
  database: FakeDatabase,
  storageKey: string,
  overrides: Partial<ResearchSourceSetRecord> = {},
  row: Record<string, unknown> = {},
): void {
  database.seed(
    `researchSource/${TENANT_ID}/sets/${storageKey}`,
    makeSourceSet(storageKey, overrides),
  );
  database.seed(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(storageKey, 1)}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: 1000,
    win: true,
    source: 'startgg',
    opponent: 'mkleo',
    ...row,
  });
}

/** A scripted YouTube Data API fetch returning the given items per query substring. */
function makeYoutubeFetch(
  itemsByQueryFragment: Record<string, unknown[]>,
  options: { failAll?: boolean } = {},
): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    if (options.failAll) {
      return new Response('quota exceeded', { status: 403 });
    }
    const query = new URL(url).searchParams.get('q') ?? '';
    const fragment = Object.keys(itemsByQueryFragment).find((key) => query.includes(key));
    return new Response(JSON.stringify({ items: fragment ? itemsByQueryFragment[fragment] : [] }));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const YT_CONFIG = { apiKey: 'test-key' };

// ---------------------------------------------------------------------------
// Candidate store
// ---------------------------------------------------------------------------

describe('writeVodCandidate', () => {
  it('persists a candidate only if absent — an existing record (any status) is never overwritten', async () => {
    const database = new FakeDatabase();
    const first = await writeVodCandidate(asDatabase(database), TENANT_ID, makeCandidate());
    expect(first.outcome).toBe('created');

    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-1',
      2000,
    );
    const replay = await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({ title: 'a re-discovered variant' }),
    );
    expect(replay.outcome).toBe('skipped-existing');
    const stored = await listVodCandidatesForTenant(asDatabase(database), TENANT_ID);
    expect(stored[0]?.status).toBe('confirmed');
    expect(stored[0]?.title).toBe('Sparg0 vs MkLeo - Grand Final - Supernova 2026');
  });

  it('rejects unsafe keys without writing', async () => {
    const database = new FakeDatabase();
    const result = await writeVodCandidate(asDatabase(database), 'unsafe/tenant', makeCandidate());
    expect(result.outcome).toBe('rejected-key');
    expect(database.dump()).toEqual({});
  });
});

describe('confirmVodCandidateByAdmin / dismissVodCandidateByAdmin', () => {
  it('confirm reloads the stored candidate and stamps confirmedByUid/confirmedAtMs; a second confirm reports already-confirmed', async () => {
    const database = new FakeDatabase();
    await writeVodCandidate(asDatabase(database), TENANT_ID, makeCandidate());

    const first = await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-1',
      5000,
    );
    expect(first.outcome).toBe('confirmed');
    const [stored] = await listVodCandidatesForTenant(asDatabase(database), TENANT_ID);
    expect(stored?.status).toBe('confirmed');
    expect(stored?.confirmedByUid).toBe('admin-1');
    expect(stored?.confirmedAtMs).toBe(5000);

    const second = await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-2',
      6000,
    );
    expect(second.outcome).toBe('already-confirmed');
  });

  it('confirm of a missing candidate is rejected-not-found; nothing is fabricated', async () => {
    const database = new FakeDatabase();
    const result = await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-missing',
      'admin-1',
      5000,
    );
    expect(result.outcome).toBe('rejected-not-found');
    expect(database.dump()).toEqual({});
  });

  it('dismiss stamps the dismissal and clears a prior confirmation; an admin can later re-confirm', async () => {
    const database = new FakeDatabase();
    await writeVodCandidate(asDatabase(database), TENANT_ID, makeCandidate());
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-1',
      5000,
    );
    await dismissVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-1',
      6000,
    );

    const [stored] = await listVodCandidatesForTenant(asDatabase(database), TENANT_ID);
    expect(stored?.status).toBe('dismissed');
    expect(stored?.dismissedByUid).toBe('admin-1');
    expect(stored?.confirmedByUid).toBeUndefined();
    expect(
      await listConfirmedVodCandidatesForSet(asDatabase(database), TENANT_ID, 'set-1'),
    ).toEqual([]);

    const reconfirm = await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-abc123',
      'admin-2',
      7000,
    );
    expect(reconfirm.outcome).toBe('confirmed');
  });
});

describe('readConfirmedCandidateVodForSet', () => {
  it('returns the strongest confirmed candidate deterministically (score desc, then candidateId), and null when none is confirmed', async () => {
    const database = new FakeDatabase();
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        candidateId: 'yt-a',
        videoId: 'a',
        videoUrl: 'https://www.youtube.com/watch?v=a',
        score: 1,
      }),
    );
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        candidateId: 'yt-b',
        videoId: 'b',
        videoUrl: 'https://www.youtube.com/watch?v=b',
        score: 5,
      }),
    );
    expect(
      await readConfirmedCandidateVodForSet(asDatabase(database), TENANT_ID, 'set-1'),
    ).toBeNull();

    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-a',
      'admin-1',
      1,
    );
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      'set-1',
      'yt-b',
      'admin-1',
      2,
    );
    expect(await readConfirmedCandidateVodForSet(asDatabase(database), TENANT_ID, 'set-1')).toEqual(
      {
        candidateId: 'yt-b',
        videoUrl: 'https://www.youtube.com/watch?v=b',
      },
    );
  });
});

// ---------------------------------------------------------------------------
// A confirmed candidate projects at priority 5 through the ordinary applier
// ---------------------------------------------------------------------------

describe('confirmed candidates in the projection applier', () => {
  it('an admin-CONFIRMED candidate fills empty rows through the witness discipline; a PROPOSED one never projects', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'set-project';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedSetWithRow(database, targetSetId);
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        targetSetId,
        candidateId: 'yt-proj',
        videoId: 'proj',
        videoUrl: 'https://www.youtube.com/watch?v=proj',
      }),
    );

    // Proposed: applying the set's (empty) overlay writes NOTHING.
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      1000,
    );
    const rowBefore = (
      (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[key] as { vodUrl?: string };
    expect(rowBefore.vodUrl).toBeUndefined();

    // Confirmed: the same apply now fills the row and stamps the witness
    // with the CANDIDATE id, never an observation id.
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      'yt-proj',
      'admin-1',
      2000,
    );
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      3000,
    );
    const rowAfter = (
      (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[key] as { vodUrl?: string };
    expect(rowAfter.vodUrl).toBe('https://www.youtube.com/watch?v=proj');
    const witness = (
      (database.dump().researchEnrichmentProjection as Record<string, unknown>)[
        TENANT_ID
      ] as Record<string, unknown>
    )[key] as { projectedVodUrl?: string; vodCandidateId?: string; vodObservationId?: string };
    expect(witness.projectedVodUrl).toBe('https://www.youtube.com/watch?v=proj');
    expect(witness.vodCandidateId).toBe('yt-proj');
    expect(witness.vodObservationId).toBeUndefined();
  });

  it('a candidate NEVER overwrites a user-typed URL, and an observation-supplied URL outranks it on the same key', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'set-priority';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedSetWithRow(database, targetSetId, {}, { vodUrl: 'https://user-typed.example/clip' });
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        targetSetId,
        candidateId: 'yt-weak',
        videoId: 'weak',
        videoUrl: 'https://www.youtube.com/watch?v=weak',
      }),
    );
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      'yt-weak',
      'admin-1',
      1000,
    );

    // User URL wins (priority 1).
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      2000,
    );
    expect(outcome.rows[0]?.vodOutcome).toBe('skipped-user-owned');
    const row = (
      (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[key] as { vodUrl?: string };
    expect(row.vodUrl).toBe('https://user-typed.example/clip');

    // An observation URL on the same key outranks the candidate (3/4 > 5).
    const database2 = new FakeDatabase();
    seedSetWithRow(database2, targetSetId);
    await writeVodCandidate(
      asDatabase(database2),
      TENANT_ID,
      makeCandidate({
        targetSetId,
        candidateId: 'yt-weak',
        videoId: 'weak',
        videoUrl: 'https://www.youtube.com/watch?v=weak',
      }),
    );
    await confirmVodCandidateByAdmin(
      asDatabase(database2),
      TENANT_ID,
      targetSetId,
      'yt-weak',
      'admin-1',
      1000,
    );
    await applyEnrichmentProjection(
      asDatabase(database2),
      TENANT_ID,
      targetSetId,
      {
        enrichedVodUrlByKey: { [key]: 'https://www.youtube.com/watch?v=fromObservation' },
        enrichedVodSourceByKey: {
          [key]: { observationId: 'obs-1', sourceRevisionId: 5, parserVersion: 'p@1' },
        },
        enrichedStageByKey: {},
      },
      2000,
    );
    const row2 = (
      (database2.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[key] as { vodUrl?: string };
    expect(row2.vodUrl).toBe('https://www.youtube.com/watch?v=fromObservation');
  });

  it('dismissing a previously confirmed candidate removes its projected URL on the next apply (witness discipline, never dangling)', async () => {
    const database = new FakeDatabase();
    const targetSetId = 'set-dismiss';
    const key = deriveEnrichmentMatchRowKey(targetSetId, 1);
    seedSetWithRow(database, targetSetId);
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        targetSetId,
        candidateId: 'yt-gone',
        videoId: 'gone',
        videoUrl: 'https://www.youtube.com/watch?v=gone',
      }),
    );
    await confirmVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      'yt-gone',
      'admin-1',
      1000,
    );
    await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      2000,
    );

    await dismissVodCandidateByAdmin(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      'yt-gone',
      'admin-1',
      3000,
    );
    const outcome = await applyEnrichmentProjection(
      asDatabase(database),
      TENANT_ID,
      targetSetId,
      { enrichedVodUrlByKey: {}, enrichedStageByKey: {} },
      4000,
    );
    expect(outcome.rows[0]?.vodOutcome).toBe('source-removed');
    const row = (
      (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[key] as { vodUrl?: string };
    expect(row.vodUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Target selection + the bounded discovery pass
// ---------------------------------------------------------------------------

describe('buildVodDiscoveryQuery / scoreVodCandidate', () => {
  it('builds tournament + entrants + round, and returns null when identity is too thin to search', () => {
    expect(buildVodDiscoveryQuery(makeSourceSet('set-q'))).toBe(
      'Supernova 2026 Sparg0 vs MkLeo Grand Final',
    );
    expect(buildVodDiscoveryQuery(makeSourceSet('set-q', { event: undefined }))).toBeNull();
    expect(
      buildVodDiscoveryQuery(
        makeSourceSet('set-q', { entrants: [{ entrantId: 'e1', name: 'Solo' }] }),
      ),
    ).toBeNull();
  });

  it('scores tag hits, tournament token overlap, and round text', () => {
    const score = scoreVodCandidate({
      title: 'Sparg0 vs MkLeo - Grand Final - Supernova 2026 Ultimate Singles',
      entrantNames: ['Sparg0', 'MkLeo'],
      tournamentName: 'Supernova 2026',
      roundText: 'Grand Final',
    });
    expect(score).toBe(6); // 2 + 2 tags, +1 tournament, +1 round
    expect(scoreVodCandidate({ title: 'unrelated video', entrantNames: ['Sparg0', 'MkLeo'] })).toBe(
      0,
    );
  });
});

describe('selectVodDiscoveryTargets', () => {
  it('selects recent-first UNMATCHED sets, skips sets with any vodUrl, skips already-discovered sets, and honors the bound', async () => {
    const database = new FakeDatabase();
    seedSetWithRow(database, 'set-old', { completedAt: 100 });
    seedSetWithRow(database, 'set-new', { completedAt: 300 });
    seedSetWithRow(database, 'set-mid', { completedAt: 200 });
    // Has a VOD already — never a discovery target.
    seedSetWithRow(
      database,
      'set-has-vod',
      { completedAt: 400 },
      { vodUrl: 'https://user.example/v' },
    );
    // Already discovered — a candidate child exists.
    seedSetWithRow(database, 'set-discovered', { completedAt: 500 });
    await writeVodCandidate(
      asDatabase(database),
      TENANT_ID,
      makeCandidate({
        targetSetId: 'set-discovered',
        candidateId: 'yt-x',
        videoId: 'x',
        videoUrl: 'https://www.youtube.com/watch?v=x',
      }),
    );

    const { consideredSets, targets } = await selectVodDiscoveryTargets(
      asDatabase(database),
      TENANT_ID,
      2,
    );
    expect(consideredSets).toBe(4); // set-discovered excluded up front
    // Recent-first, vod-bearing set skipped, bound of 2 respected.
    expect(targets.map((t) => t.targetSetId)).toEqual(['set-new', 'set-mid']);
  });
});

describe('runVodCandidateDiscovery', () => {
  const SEARCH_ITEM = {
    id: { videoId: 'foundVideo1' },
    snippet: {
      title: 'Sparg0 vs MkLeo - Grand Final - Supernova 2026',
      channelId: 'chan-1',
      channelTitle: 'Supernova VODs',
      publishedAt: '2026-05-17T00:00:00Z',
    },
  };

  it('persists every result as a PROPOSED candidate with query/title/channel/date/id/fetch-time/score, and writes NOTHING to matches or witnesses', async () => {
    const database = new FakeDatabase();
    seedSetWithRow(database, 'set-a', { completedAt: 300 });
    const { fetchImpl, requests } = makeYoutubeFetch({ Supernova: [SEARCH_ITEM] });

    const report = await runVodCandidateDiscovery(
      asDatabase(database),
      TENANT_ID,
      { config: YT_CONFIG, fetchImpl },
      9000,
    );

    expect(report.bound).toBe(VOD_DISCOVERY_MAX_SETS_PER_RUN);
    expect(report.queriedSets).toBe(1);
    expect(report.candidatesWritten).toBe(1);
    expect(requests).toHaveLength(1);
    const requestUrl = new URL(requests[0]!);
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      'https://www.googleapis.com/youtube/v3/search',
    );
    expect(requestUrl.searchParams.get('maxResults')).toBe(
      String(VOD_DISCOVERY_MAX_RESULTS_PER_SET),
    );
    expect(requestUrl.searchParams.get('key')).toBe('test-key');

    const [candidate] = await listVodCandidatesForTenant(asDatabase(database), TENANT_ID);
    expect(candidate).toMatchObject({
      candidateId: 'yt-foundVideo1',
      targetSetId: 'set-a',
      provider: 'youtube-data-api',
      query: 'Supernova 2026 Sparg0 vs MkLeo Grand Final',
      videoId: 'foundVideo1',
      videoUrl: 'https://www.youtube.com/watch?v=foundVideo1',
      title: 'Sparg0 vs MkLeo - Grand Final - Supernova 2026',
      channelId: 'chan-1',
      channelTitle: 'Supernova VODs',
      publishedAt: '2026-05-17T00:00:00Z',
      fetchedAtMs: 9000,
      status: 'proposed',
    });
    expect(candidate!.score).toBeGreaterThan(0);

    // A candidate is a CANDIDATE: no row member and no witness changed.
    const row = (
      (database.dump().matches as Record<string, unknown>)[TENANT_ID] as Record<string, unknown>
    )[deriveEnrichmentMatchRowKey('set-a', 1)] as { vodUrl?: string };
    expect(row.vodUrl).toBeUndefined();
    expect(database.dump().researchEnrichmentProjection).toBeUndefined();
  });

  it('caps the pass at the explicit bound and reports it', async () => {
    const database = new FakeDatabase();
    for (let index = 0; index < 5; index += 1) {
      seedSetWithRow(database, `set-bound-${index}`, { completedAt: 100 + index });
    }
    const { fetchImpl, requests } = makeYoutubeFetch({ Supernova: [] });

    const report = await runVodCandidateDiscovery(
      asDatabase(database),
      TENANT_ID,
      { config: YT_CONFIG, fetchImpl },
      9000,
      3,
    );
    expect(report.bound).toBe(3);
    expect(report.queriedSets).toBe(3);
    expect(requests).toHaveLength(3);
  });

  it('counts a failed query and continues; a re-run against existing candidates skips them rather than overwriting', async () => {
    const database = new FakeDatabase();
    seedSetWithRow(database, 'set-fail', { completedAt: 300 });
    const failing = makeYoutubeFetch({}, { failAll: true });
    const failReport = await runVodCandidateDiscovery(
      asDatabase(database),
      TENANT_ID,
      { config: YT_CONFIG, fetchImpl: failing.fetchImpl },
      9000,
    );
    expect(failReport.queryFailures).toBe(1);
    expect(failReport.candidatesWritten).toBe(0);

    const succeeding = makeYoutubeFetch({ Supernova: [SEARCH_ITEM] });
    const okReport = await runVodCandidateDiscovery(
      asDatabase(database),
      TENANT_ID,
      { config: YT_CONFIG, fetchImpl: succeeding.fetchImpl },
      9500,
    );
    expect(okReport.candidatesWritten).toBe(1);

    // Third pass: the set now HAS candidates, so it is not re-queried at all.
    const third = makeYoutubeFetch({ Supernova: [SEARCH_ITEM] });
    const thirdReport = await runVodCandidateDiscovery(
      asDatabase(database),
      TENANT_ID,
      { config: YT_CONFIG, fetchImpl: third.fetchImpl },
      9900,
    );
    expect(third.requests).toHaveLength(0);
    expect(thirdReport.queriedSets).toBe(0);
  });
});
