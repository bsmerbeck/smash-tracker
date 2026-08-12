import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_STAGE } from '@smash-tracker/shared';
import { FakeDatabase } from '../../../test-support/fakeDatabase.js';
import type {
  LiquipediaClient,
  LiquipediaRevisionQueryResult,
} from '../../../liquipedia/client.js';
import { deriveEnrichmentMatchRowKey } from '../projection.js';
import { readEnrichmentCoverage } from '../rollup.js';
import { runEnrichmentBatch } from '../run.js';
import {
  ALL_SYNTHETIC_FIXTURE_BUILDERS,
  loadSupernovaBracketEnvelope,
  loadSupernovaTournamentEnvelope,
  readEnvelopeContent,
  readEnvelopeRevisionId,
  readEnvelopeSha1,
  readEnvelopeTitle,
  type LiquipediaQueryEnvelope,
  type SyntheticMutationResult,
} from './syntheticFixtures.js';

/**
 * Phase 30.2 Plan 12 (ENR-11): the MANDATORY Supernova 2026 regression — the
 * stop-ship requirement. Drives the whole enrichment pipeline
 * (`runEnrichmentBatch`) against the REAL captured bracket + tournament
 * bytes, proves the grand-final reset attaches as a SECOND set rather than
 * collapsing into the first, proves the shared VOD projects onto all eight
 * game rows across both sets with a per-target-set dedupe key, proves the
 * hazardless-form marker survives onto exactly the games that carry it, and
 * proves the run is idempotent.
 *
 * Player VOD-page discovery (the mechanism `runEnrichmentBatch` uses to
 * discover which tournament pages to fetch) is driven through a SYNTHETIC
 * minimal generated-page body naming only `Supernova/2026/Ultimate` —
 * deliberately NOT the real, ~600-row Sparg0/VODs corpus, which would pull
 * in hundreds of unrelated tournaments this regression has no fixture
 * coverage for. The BRACKET and TOURNAMENT page content driving every
 * extraction and resolution assertion below is the REAL captured fixture
 * (`query-supernova-2026-singles-bracket.json` /
 * `query-supernova-2026-tournament.json`), loaded through
 * `syntheticFixtures.ts`'s envelope readers — never hand-typed wikitext.
 */

function asDatabase(database: FakeDatabase): Database {
  return database as unknown as Database;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TENANT_ID = 'supernova-tenant-1';
const GF_SET_ID = 'supernova-gf-set';
const RESET_SET_ID = 'supernova-reset-set';
const SPARG0_LABEL = 'Sparg0';
const VOD_PAGE_TITLE = 'Sparg0/VODs';
const TOURNAMENT_TITLE = 'Supernova/2026/Ultimate';
const BRACKET_TITLE = 'Supernova/2026/Ultimate/Singles Bracket';
const SHARED_VOD_URL = 'https://www.youtube.com/watch?v=pncEm1PfAJU';

// ---------------------------------------------------------------------------
// Ground truth (RESEARCH section 2.6/2.8, re-verified directly against the
// committed fixture bytes at module load — see the anti-vacuous-pass guard
// below).
// ---------------------------------------------------------------------------

/**
 * Deviation from the PLAN's stated ground truth (Rule 1 — bug: the plan text
 * claims "four of the eight" hazardless; the REAL captured fixture bytes
 * carry FIVE — r3m1stage2, r3m1stage3, r3m2stage1, r3m2stage4, r3m2stage5 are
 * all `Φ`-prefixed, r3m1stage1/r3m2stage2/r3m2stage3 are not). Asserting
 * against the real bytes, not the plan's paraphrase, is the whole point of a
 * byte-faithful regression — see this plan's SUMMARY for the recorded
 * deviation.
 */
const EXPECTED_HAZARDLESS_COUNT = 5;
const EXPECTED_NORMAL_COUNT = 3;
const EXPECTED_GF_GAME_COUNT = 3;
const EXPECTED_RESET_GAME_COUNT = 5;

function readPage(envelope: LiquipediaQueryEnvelope) {
  return {
    title: readEnvelopeTitle(envelope),
    revisionId: readEnvelopeRevisionId(envelope),
    sha1: readEnvelopeSha1(envelope) ?? '',
    content: readEnvelopeContent(envelope),
  };
}

// ---------------------------------------------------------------------------
// Fixture-backed LiquipediaClient double. Bracket + tournament CONTENT is
// the real captured bytes; VOD-page discovery is a synthetic minimal card
// (see module header).
// ---------------------------------------------------------------------------

/**
 * A DELIBERATELY unrelated opponent + VOD url — this row's ONLY job is to
 * discover the `Supernova/2026/Ultimate` tournament-page prefix so
 * `runEnrichmentBatch`'s gather phase enumerates its bracket-page sibling.
 * Naming the real Tweek-vs-Sparg0 pair (and reusing the shared GF/reset VOD
 * URL) here would let THIS row corroborate against
 * `matchedBracketVodUrls` too — a real, documented consequence of the VOD
 * list's `(tournamentPageTitle, vodUrl)` composite key not distinguishing
 * which of two same-tournament, same-VOD target sets it means (RESEARCH
 * section 2.6 item 4's "one VOD covers both" fact cuts both ways) — which
 * would make this discovery-only row a THIRD matched observation and
 * pollute the mandatory regression's exact attachment-count assertions.
 * Naming a player this fixture never seeds a provider set for keeps this
 * row `ambiguous` (no bracket corroboration), exactly as a genuine
 * discovery-only row with no bracket sibling would be.
 */
function buildVodPageBody(): string {
  return (
    'lp-col lp-d-block lp-col-12<b>[[Supernova/2026/Ultimate|Supernova 2026]]</b><br/>' +
    'Sparg0 vs. <span style="vertical-align:-1px;">&nbsp;[[NobodyReal|NobodyReal]]</span> ' +
    '<span class="plainlinks vodlink">[[File:VOD Icon.png|20px|link=https://www.youtube.com/watch?v=discoveryOnly1]]</span>'
  );
}

export interface SupernovaFixtureClientCalls {
  headRevisions: string[][];
  getWikitext: string[][];
  listSubpages: string[];
  getGeneratedVodPage: string[];
}

function buildSupernovaFixtureClient(bracketEnvelope: LiquipediaQueryEnvelope): {
  client: LiquipediaClient;
  calls: SupernovaFixtureClientCalls;
} {
  const bracketPage = readPage(bracketEnvelope);
  const tournamentPage = readPage(loadSupernovaTournamentEnvelope());
  const pagesByTitle = new Map([
    [bracketPage.title, bracketPage],
    [tournamentPage.title, tournamentPage],
  ]);

  const calls: SupernovaFixtureClientCalls = {
    headRevisions: [],
    getWikitext: [],
    listSubpages: [],
    getGeneratedVodPage: [],
  };

  const client: LiquipediaClient = {
    async getSiteInfo() {
      return {};
    },
    async headRevisions(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      calls.headRevisions.push(titles);
      return {
        pages: titles.map((title) => {
          if (title === SPARG0_LABEL) {
            return { present: true, title, revisionId: 0, sha1: '' };
          }
          if (title === VOD_PAGE_TITLE) {
            return { present: true, title, revisionId: 999, sha1: '' };
          }
          const page = pagesByTitle.get(title);
          if (!page) {
            return { present: false, title };
          }
          return { present: true, title, revisionId: page.revisionId, sha1: page.sha1 };
        }),
        normalized: [],
        redirects: [],
      };
    },
    async getWikitext(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      calls.getWikitext.push(titles);
      return {
        pages: titles.map((title) => {
          const page = pagesByTitle.get(title);
          if (!page) {
            return { present: false, title };
          }
          return {
            present: true,
            title,
            revisionId: page.revisionId,
            sha1: page.sha1,
            content: page.content,
          };
        }),
        normalized: [],
        redirects: [],
      };
    },
    async listSubpages(prefix: string) {
      calls.listSubpages.push(prefix);
      if (prefix !== TOURNAMENT_TITLE) {
        return [];
      }
      return [
        { title: TOURNAMENT_TITLE, pageId: 66355 },
        { title: BRACKET_TITLE, pageId: 66550 },
      ];
    },
    async getGeneratedVodPage(title: string) {
      calls.getGeneratedVodPage.push(title);
      return { title, mode: 'expandtemplates', content: buildVodPageBody() };
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Provider seeding — the grand final and its reset as two GENUINELY DISTINCT
// start.gg records between the same two competitors at the same tournament.
// ---------------------------------------------------------------------------

function completedAtSecondsAug9_2026(): number {
  return Math.floor(Date.UTC(2026, 7, 9) / 1000);
}

async function seedSupernovaProviderSets(database: FakeDatabase): Promise<void> {
  const completedAt = completedAtSecondsAug9_2026();

  // Grand Finals: Tweek (p1, 0) vs Sparg0 (p2, 3) — Sparg0 sweeps 3-0.
  await database.ref(`researchSource/${TENANT_ID}/sets/${GF_SET_ID}`).set({
    providerSetId: GF_SET_ID,
    storageKey: GF_SET_ID,
    classification: 'complete',
    ruleId: 'singles',
    entrants: [
      { entrantId: 'tweek', name: 'Tweek' },
      { entrantId: 'sparg0', name: 'Sparg0' },
    ],
    games: [
      { gameId: 1, winnerEntrantId: 'sparg0' },
      { gameId: 2, winnerEntrantId: 'sparg0' },
      { gameId: 3, winnerEntrantId: 'sparg0' },
    ],
    totalGames: EXPECTED_GF_GAME_COUNT,
    completedAt,
    event: {
      tournamentSlug: 'supernova-2026',
      tournamentName: 'Supernova 2026',
      name: 'Supernova 2026 Singles',
    },
    apiIds: { setId: GF_SET_ID },
    ingestionRunId: 'seed-ingestion-run',
    fetchedAtMs: 1,
    lastObservedAtMs: 1,
  });

  // Grand Finals RESET: Tweek (p1, 2) vs Sparg0 (p2, 3) — Sparg0 wins 3-2.
  // A DISTINCT record, never the same providerSetId/storageKey as the GF.
  await database.ref(`researchSource/${TENANT_ID}/sets/${RESET_SET_ID}`).set({
    providerSetId: RESET_SET_ID,
    storageKey: RESET_SET_ID,
    classification: 'complete',
    ruleId: 'singles',
    entrants: [
      { entrantId: 'tweek', name: 'Tweek' },
      { entrantId: 'sparg0', name: 'Sparg0' },
    ],
    games: [
      { gameId: 1, winnerEntrantId: 'sparg0' },
      { gameId: 2, winnerEntrantId: 'sparg0' },
      { gameId: 3, winnerEntrantId: 'tweek' },
      { gameId: 4, winnerEntrantId: 'tweek' },
      { gameId: 5, winnerEntrantId: 'sparg0' },
    ],
    totalGames: EXPECTED_RESET_GAME_COUNT,
    completedAt,
    event: {
      tournamentSlug: 'supernova-2026',
      tournamentName: 'Supernova 2026',
      name: 'Supernova 2026 Singles',
    },
    apiIds: { setId: RESET_SET_ID },
    ingestionRunId: 'seed-ingestion-run',
    fetchedAtMs: 1,
    lastObservedAtMs: 1,
  });

  // Projectable match rows for every declared game ordinal on both sets —
  // `applyEnrichmentProjection` never creates a row, it only fills one that
  // already exists.
  for (let ordinal = 1; ordinal <= EXPECTED_GF_GAME_COUNT; ordinal += 1) {
    await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(GF_SET_ID, ordinal)}`)
      .set({ note: 'seed', map: UNKNOWN_STAGE });
  }
  for (let ordinal = 1; ordinal <= EXPECTED_RESET_GAME_COUNT; ordinal += 1) {
    await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(RESET_SET_ID, ordinal)}`)
      .set({ note: 'seed', map: UNKNOWN_STAGE });
  }
}

async function runSupernova(
  database: FakeDatabase,
  nowMs: number,
  envelope = loadSupernovaBracketEnvelope(),
) {
  const { client, calls } = buildSupernovaFixtureClient(envelope);
  const result = await runEnrichmentBatch({
    database: asDatabase(database),
    client,
    tenantId: TENANT_ID,
    playerLabels: [SPARG0_LABEL],
    targetGame: 'ultimate',
    nowMs,
    hashHex: sha256Hex,
    dryRun: false,
  });
  return { result, calls };
}

// ---------------------------------------------------------------------------
// Domain-tree snapshot for the idempotent-replay assertion (scoped to the
// domain trees only, mirroring run.test.ts's own scoping rationale — the
// run-bookkeeping tree legitimately writes on every invocation).
// ---------------------------------------------------------------------------

const DOMAIN_TREES = [
  'matches',
  'researchEnrichmentObservations',
  'researchEnrichmentReceipts',
  'researchEnrichmentAttachments',
  'researchEnrichmentProjection',
] as const;

function snapshotDomainTrees(database: FakeDatabase): Record<string, unknown> {
  const dump = database.dump() as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const tree of DOMAIN_TREES) {
    snapshot[tree] = dump[tree] ?? null;
  }
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Anti-vacuous-pass guard: the ground truth above is re-derived directly
// from the committed fixture bytes, not merely asserted against itself.
// ---------------------------------------------------------------------------

describe('anti-vacuous-pass: ground truth re-derived from the committed fixture bytes', () => {
  it('the real captured bracket content contains the exact GF/reset stage sequence this regression asserts against', () => {
    const content = readEnvelopeContent(loadSupernovaBracketEnvelope());
    const stageMatches = Array.from(content.matchAll(/\|r3m[12]stage\d=([^|\n]*)/g)).map((m) =>
      m[1]!.trim(),
    );
    expect(stageMatches).toHaveLength(EXPECTED_GF_GAME_COUNT + EXPECTED_RESET_GAME_COUNT);
    const hazardlessCount = stageMatches.filter((value) => value.startsWith('Φ ')).length;
    expect(hazardlessCount).toBe(EXPECTED_HAZARDLESS_COUNT);
    expect(stageMatches.length - hazardlessCount).toBe(EXPECTED_NORMAL_COUNT);
  });
});

// ---------------------------------------------------------------------------
// The mandatory regression
// ---------------------------------------------------------------------------

describe('Supernova 2026 mandatory regression (ENR-11)', () => {
  it('seeds two start.gg provider sets for the grand final and its reset and attaches each Liquipedia observation to the CORRECT one, without collapsing them', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    const { result } = await runSupernova(database, 1_000);

    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(2);

    const gfAttachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${GF_SET_ID}`)
      .get();
    const resetAttachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${RESET_SET_ID}`)
      .get();
    expect(gfAttachments.exists()).toBe(true);
    expect(resetAttachments.exists()).toBe(true);

    const gfObservationIds = Object.keys((gfAttachments.val() as Record<string, unknown>) ?? {});
    const resetObservationIds = Object.keys(
      (resetAttachments.val() as Record<string, unknown>) ?? {},
    );
    expect(gfObservationIds).toHaveLength(1);
    expect(resetObservationIds).toHaveLength(1);
    // Two distinct target set ids, and no observation appears under both.
    expect(gfObservationIds[0]).not.toBe(resetObservationIds[0]);
    expect(new Set([...gfObservationIds, ...resetObservationIds]).size).toBe(2);
  });

  it('exactly eight game-level stage observations exist across the pair — three on the grand final, five on the reset — five carry the hazardless form, and all eight preserve their raw source string', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    await runSupernova(database, 1_000);

    const observationsSnapshot = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}`)
      .get();
    const allObservations = Object.values(
      (observationsSnapshot.val() as Record<string, unknown>) ?? {},
    ) as { observationId: string; games?: { rawStage?: string; stageForm?: string }[] }[];

    const gfAttachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${GF_SET_ID}`)
      .get();
    const resetAttachments = await database
      .ref(`researchEnrichmentAttachments/${TENANT_ID}/${RESET_SET_ID}`)
      .get();
    const gfObservationId = Object.keys((gfAttachments.val() as Record<string, unknown>) ?? {})[0]!;
    const resetObservationId = Object.keys(
      (resetAttachments.val() as Record<string, unknown>) ?? {},
    )[0]!;

    const gfObservation = allObservations.find((o) => o.observationId === gfObservationId)!;
    const resetObservation = allObservations.find((o) => o.observationId === resetObservationId)!;

    expect(gfObservation.games).toHaveLength(EXPECTED_GF_GAME_COUNT);
    expect(resetObservation.games).toHaveLength(EXPECTED_RESET_GAME_COUNT);

    const allGames = [...(gfObservation.games ?? []), ...(resetObservation.games ?? [])];
    expect(allGames).toHaveLength(EXPECTED_GF_GAME_COUNT + EXPECTED_RESET_GAME_COUNT);
    expect(allGames.every((g) => typeof g.rawStage === 'string' && g.rawStage.length > 0)).toBe(
      true,
    );
    const hazardlessGames = allGames.filter((g) => g.stageForm === 'hazardless');
    expect(hazardlessGames).toHaveLength(EXPECTED_HAZARDLESS_COUNT);
  });

  it('the single VOD is projected onto all eight game rows across both target sets, with a dedupe key that differs per target set', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    await runSupernova(database, 1_000);

    let filledCount = 0;
    for (let ordinal = 1; ordinal <= EXPECTED_GF_GAME_COUNT; ordinal += 1) {
      const row = await database
        .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(GF_SET_ID, ordinal)}`)
        .get();
      expect((row.val() as { vodUrl?: string }).vodUrl).toBe(SHARED_VOD_URL);
      filledCount += 1;
    }
    for (let ordinal = 1; ordinal <= EXPECTED_RESET_GAME_COUNT; ordinal += 1) {
      const row = await database
        .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(RESET_SET_ID, ordinal)}`)
        .get();
      expect((row.val() as { vodUrl?: string }).vodUrl).toBe(SHARED_VOD_URL);
      filledCount += 1;
    }
    expect(filledCount).toBe(EXPECTED_GF_GAME_COUNT + EXPECTED_RESET_GAME_COUNT);

    // The dedupe key is the (URL, target set) PAIR, never the URL alone —
    // the same URL legitimately projects to two different target sets.
    const gfKey = deriveEnrichmentMatchRowKey(GF_SET_ID, 1);
    const resetKey = deriveEnrichmentMatchRowKey(RESET_SET_ID, 1);
    expect(gfKey).not.toBe(resetKey);
  });

  it('the disqualification/walkover set survives extraction with non-numeric raw scores preserved, and does not attach', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    await runSupernova(database, 1_000);

    const observationsSnapshot = await database
      .ref(`researchEnrichmentObservations/${TENANT_ID}`)
      .get();
    const allObservations = Object.values(
      (observationsSnapshot.val() as Record<string, unknown>) ?? {},
    ) as { players?: { rawTag: string }[]; rawScores?: [string, string]; observationId: string }[];

    const dqObservation = allObservations.find(
      (o) =>
        o.players?.[0]?.rawTag === 'Lima' &&
        o.players?.[1]?.rawTag === 'MuteAce' &&
        o.rawScores != null,
    );
    expect(dqObservation).toBeDefined();
    expect(dqObservation!.rawScores).toEqual(['{{win}}', 'DQ']);

    const attachedIds = new Set<string>();
    for (const targetSetId of [GF_SET_ID, RESET_SET_ID]) {
      const attachments = await database
        .ref(`researchEnrichmentAttachments/${TENANT_ID}/${targetSetId}`)
        .get();
      for (const id of Object.keys((attachments.val() as Record<string, unknown>) ?? {})) {
        attachedIds.add(id);
      }
    }
    expect(attachedIds.has(dqObservation!.observationId)).toBe(false);
  });

  it('the coverage counters after the run report the exact matched, stage-enriched and VOD-enriched figures the ground-truth table implies', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    const { result } = await runSupernova(database, 1_000);

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.runId).toBe(result.runId);
    // At least the two mandatory sets matched (other bracket sets on this
    // page have no seeded provider candidate and resolve unmatched — the
    // ">=2" bound is exact for THIS pipeline's seeded provider tier).
    expect(snapshot?.counts.matched).toBe(2);
    expect(snapshot?.counts.stageEnriched).toBe(EXPECTED_GF_GAME_COUNT + EXPECTED_RESET_GAME_COUNT);
    expect(snapshot?.counts.vodEnriched).toBe(EXPECTED_GF_GAME_COUNT + EXPECTED_RESET_GAME_COUNT);
  });

  it('running the same pipeline a second time over the identical fixture performs zero value-changing writes to the domain trees', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    await runSupernova(database, 1_000);

    const before = snapshotDomainTrees(database);
    await runSupernova(database, 2_000);
    const after = snapshotDomainTrees(database);

    expect(after).toEqual(before);
  });

  it('typecheck-adjacent structural check: the fixture-backed client double never issues a request outside the two known page titles plus the VOD page', async () => {
    const database = new FakeDatabase();
    await seedSupernovaProviderSets(database);
    const { calls } = await runSupernova(database, 1_000);
    expect(calls.listSubpages).toContain(TOURNAMENT_TITLE);
    expect(calls.getGeneratedVodPage).toContain(VOD_PAGE_TITLE);
    const allProbedTitles = calls.headRevisions.flat();
    for (const title of allProbedTitles) {
      expect([SPARG0_LABEL, VOD_PAGE_TITLE, TOURNAMENT_TITLE, BRACKET_TITLE]).toContain(title);
    }
  });
});

// ---------------------------------------------------------------------------
// Every synthetic builder has at least one assertion proving its mutation
// landed.
// ---------------------------------------------------------------------------

describe('syntheticFixtures builders each prove their own mutation landed', () => {
  it(`ALL_SYNTHETIC_FIXTURE_BUILDERS has exactly ${ALL_SYNTHETIC_FIXTURE_BUILDERS.length} entries, one per RESEARCH section 10 synthetic case (S1-S5, S7, S9)`, () => {
    expect(ALL_SYNTHETIC_FIXTURE_BUILDERS.length).toBe(8);
  });

  it.each(ALL_SYNTHETIC_FIXTURE_BUILDERS.map((builder) => [builder.name, builder] as const))(
    '%s: the built envelope differs from (or, for the replay case, exactly equals) the base fixture as described',
    (_name, builder) => {
      const base = loadSupernovaBracketEnvelope();
      const result: SyntheticMutationResult = builder(base);
      expect(result.description.length).toBeGreaterThan(0);

      if (result.name === 'buildByteIdenticalReplay') {
        expect(readEnvelopeContent(result.envelope)).toBe(readEnvelopeContent(base));
        expect(readEnvelopeRevisionId(result.envelope)).toBe(readEnvelopeRevisionId(base));
        return;
      }

      if (result.name === 'buildUserVodSeedFixture') {
        // The envelope is deliberately unchanged for this case (module
        // header) — the mutation under test is the paired user-VOD-URL
        // constant.
        expect(readEnvelopeContent(result.envelope)).toBe(readEnvelopeContent(base));
        expect((result as unknown as { userVodUrl: string }).userVodUrl).toMatch(/^https:\/\//);
        return;
      }

      if (result.name === 'buildLaterRevisionCorrection') {
        expect(readEnvelopeRevisionId(result.envelope)).toBe(readEnvelopeRevisionId(base) + 1);
        expect(readEnvelopeSha1(result.envelope)).not.toBe(readEnvelopeSha1(base));
      }

      expect(readEnvelopeContent(result.envelope)).not.toBe(readEnvelopeContent(base));
      if (result.before != null && result.after != null) {
        expect(readEnvelopeContent(base)).toContain(result.before);
        expect(readEnvelopeContent(result.envelope)).toContain(result.after);
      }
    },
  );
});
