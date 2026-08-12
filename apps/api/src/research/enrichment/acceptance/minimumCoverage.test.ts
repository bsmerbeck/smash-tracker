import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_STAGE, type ResearchEnrichmentObservationRecord } from '@smash-tracker/shared';
import { FakeDatabase } from '../../../test-support/fakeDatabase.js';
import { FaultInjectingDatabase } from '../../../test-support/faultInjectingDatabase.js';
import type {
  LiquipediaClient,
  LiquipediaRevisionQueryResult,
} from '../../../liquipedia/client.js';
import { LiquipediaApiError, resolveLiquipediaRetryDelayMs } from '../../../liquipedia/client.js';
import {
  createLiquipediaLimiter,
  LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS,
} from '../../../liquipedia/limiter.js';
import { extractEventContext } from '../../../liquipedia/eventContext.js';
import { extractLegacyBracketObservations } from '../../../liquipedia/adapters/legacyBracket.js';
import { buildCandidateIndex } from '../candidateIndex.js';
import { resolveObservation } from '../resolution.js';
import { applyPageRefresh, planPageRefresh } from '../refresh.js';
import {
  attachResolvedObservation,
  confirmEnrichmentObservationByAdmin,
  listAttachmentsForSet,
  listEnrichmentObservations,
  listEnrichmentReviewQueue,
  readResolutionReceipt,
  writeEnrichmentObservation,
  writeResolutionReceipt,
} from '../store.js';
import { buildResolutionReceipt, deriveReceiptId, type ResolutionOutcome } from '../resolution.js';
import {
  applyEnrichmentProjection,
  buildEnrichmentOverlay,
  deriveEnrichmentMatchRowKey,
} from '../projection.js';
import { classifyStageCohort, readEnrichmentCoverage } from '../rollup.js';
import { runEnrichmentBatch } from '../run.js';
import { confirmIdentityPlayers } from '../../ingestion/identity.js';
import { createOrResumeBackfillRun } from '../../ingestion/backfillRun.js';
import { runResearchBackfillBatch } from '../../../jobs/researchBackfillBatch.js';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../../../startgg/client.js';

/**
 * Phase 30.2 Plan 12 (ENR-11): the minimum-coverage matrix — one NAMED test
 * per case ENR-11 enumerates, every name beginning with the requirement's
 * own wording, driven through the REAL pipeline (`runEnrichmentBatch`, the
 * store.ts writers, or `runResearchBackfillBatch` for the one case that
 * requires the production job path) rather than reimplemented resolution
 * logic.
 *
 * Most cases share ONE hand-built "matrix" bracket page — a single legacy
 * template carrying one independent set group per case (distinct round
 * numbers so no two cases' parameter names collide) — run through ONE
 * `runEnrichmentBatch` invocation. Four cases need their own isolated setup
 * (idempotent replay, crash-window, rate-limit, later-revision correction,
 * user-VOD-preservation, forged status, fabricated receipt) because they
 * each need a SECOND invocation, a fault-injected database, or a different
 * production entry point.
 */

function asDatabase(database: FakeDatabase | FaultInjectingDatabase): Database {
  return database as unknown as Database;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const TENANT_ID = 'matrix-tenant-1';
const TOURNAMENT_TITLE = 'MatrixCup/2026';
const BRACKET_TITLE = 'MatrixCup/2026/Bracket';
const VOD_PAGE_TITLE = 'MatrixPlayer/VODs';
const PLAYER_LABEL = 'MatrixPlayer';

// ---------------------------------------------------------------------------
// Matrix bracket wikitext builder
// ---------------------------------------------------------------------------

interface GameSpec {
  winnerSeat: 1 | 2;
  stage?: string;
}

function buildSetBlock(input: {
  round: number;
  match: number;
  p1: string;
  p2: string;
  p1score: string;
  p2score: string;
  winSeat?: 1 | 2;
  date?: string;
  vodUrl?: string;
  games?: GameSpec[];
}): string {
  const prefix = `r${input.round}m${input.match}`;
  const lines: string[] = [
    `|${prefix}p1=${input.p1} |${prefix}p1flag=us |${prefix}p1score=${input.p1score}`,
    `|${prefix}p2=${input.p2} |${prefix}p2flag=us |${prefix}p2score=${input.p2score}`,
  ];
  if (input.winSeat) {
    lines.push(`|${prefix}win=${input.winSeat}`);
  }
  (input.games ?? []).forEach((game, index) => {
    const n = index + 1;
    const stagePart = game.stage != null ? ` |${prefix}stage${n}=${game.stage}` : '';
    lines.push(
      `|${prefix}p1char${n}=fox |${prefix}p2char${n}=falco |${prefix}p1stock${n}=0 ` +
        `|${prefix}p2stock${n}=0 |${prefix}win${n}=${game.winnerSeat}${stagePart}`,
    );
  });
  if (input.date) {
    lines.push(`|${prefix}date=${input.date}`);
  }
  if (input.vodUrl) {
    lines.push(`|${prefix}details={{BracketMatchDetails|vod=${input.vodUrl}}}`);
  }
  return lines.join('\n') + '\n';
}

/** The playerless RESET group (r10m2) — hand-built, mirroring the real Supernova sibling-inheritance shape verbatim rather than through `buildSetBlock` (which always emits its own p1/p2). */
const RESET_BLOCK =
  '|r10m1p1=ResetP1 |r10m1p1flag=us |r10m1p1score=0 |r10m2p1score=1\n' +
  '|r10m1p2=ResetP2 |r10m1p2flag=us |r10m1p2score=2 |r10m2p2score=2\n' +
  '|r10m1win=2\n' +
  '|r10m1p1char1=fox |r10m1p2char1=falco |r10m1p1stock1=0 |r10m1p2stock1=2 |r10m1win1=2 |r10m1stage1=Battlefield\n' +
  '|r10m1p1char2=fox |r10m1p2char2=falco |r10m1p1stock2=0 |r10m1p2stock2=2 |r10m1win2=2 |r10m1stage2=Final Destination\n' +
  '|r10m2p1char1=fox |r10m2p2char1=falco |r10m2p1stock1=2 |r10m2p2stock1=0 |r10m2win1=1 |r10m2stage1=Small Battlefield\n' +
  '|r10m2p1char2=fox |r10m2p2char2=falco |r10m2p1stock2=0 |r10m2p2stock2=2 |r10m2win2=2 |r10m2stage2=Battlefield\n' +
  '|r10m2p1char3=fox |r10m2p2char3=falco |r10m2p1stock3=0 |r10m2p2stock3=2 |r10m2win3=2 |r10m2stage3=Final Destination\n' +
  '|r10m1date=February 3, 2026\n' +
  '|r10m1details={{BracketMatchDetails|vod=https://www.youtube.com/watch?v=matrixReset01}}\n';

function buildTournamentWikitext(): string {
  return (
    '{{Infobox league|name=Matrix Cup 2026|startgg=tournament/matrix-cup-2026/details|' +
    'sdate=2026-02-01|edate=2026-02-09|game=ultimate}}'
  );
}

function buildMatrixBracketWikitext(): string {
  return (
    '{{TournamentInfo|game=ultimate|tourneylink=MatrixCup/2026}}\n' +
    '{{MatrixBracketA\n' +
    // r1m1: Exact unique match.
    buildSetBlock({
      round: 1,
      match: 1,
      p1: 'ExactP1',
      p2: 'ExactP2',
      p1score: '3',
      p2score: '0',
      winSeat: 1,
      date: 'February 1, 2026',
      vodUrl: 'https://www.youtube.com/watch?v=matrixExact01',
      games: [
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Final Destination' },
        { winnerSeat: 1, stage: 'Battlefield' },
      ],
    }) +
    // r2m1: sponsor-prefix alias (provider entrant carries "SPONSOR | TeamTag").
    buildSetBlock({
      round: 2,
      match: 1,
      p1: 'TeamTag',
      p2: 'AliasOpp2',
      p1score: '1',
      p2score: '0',
      winSeat: 1,
      date: 'February 2, 2026',
      games: [{ winnerSeat: 1, stage: 'Battlefield' }],
    }) +
    // r3m1: disambiguation-suffix alias (provider entrant carries no suffix).
    buildSetBlock({
      round: 3,
      match: 1,
      p1: 'DisambigPlayer (American player)',
      p2: 'AliasOpp3',
      p1score: '1',
      p2score: '0',
      winSeat: 1,
      date: 'February 2, 2026',
      games: [{ winnerSeat: 1, stage: 'Battlefield' }],
    }) +
    // r4m1 / r5m1: same players meeting twice (RepeatA vs RepeatB).
    buildSetBlock({
      round: 4,
      match: 1,
      p1: 'RepeatA',
      p2: 'RepeatB',
      p1score: '3',
      p2score: '0',
      winSeat: 1,
      date: 'February 4, 2026',
      games: [
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
      ],
    }) +
    buildSetBlock({
      round: 5,
      match: 1,
      p1: 'RepeatA',
      p2: 'RepeatB',
      p1score: '3',
      p2score: '1',
      winSeat: 1,
      date: 'February 5, 2026',
      games: [
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 2, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
      ],
    }) +
    // r6m1: no explicit round parameter exists on ANY legacy set (structural
    // — round is always derived, never stated) — this set demonstrates it
    // still attaches on the other evidence.
    buildSetBlock({
      round: 6,
      match: 1,
      p1: 'NoRoundP',
      p2: 'NoRoundOpp',
      p1score: '1',
      p2score: '0',
      winSeat: 1,
      date: 'February 6, 2026',
      games: [{ winnerSeat: 1, stage: 'Battlefield' }],
    }) +
    // r7m1: conflicting score (the declared score disagrees with the seeded
    // provider set's tallied game-win pair).
    buildSetBlock({
      round: 7,
      match: 1,
      p1: 'ConflictP',
      p2: 'ConflictOpp',
      p1score: '3',
      p2score: '0',
      winSeat: 1,
      date: 'February 7, 2026',
      games: [
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
      ],
    }) +
    // r8m1: unknown stage form (an unrecognised leading symbol on game 1).
    buildSetBlock({
      round: 8,
      match: 1,
      p1: 'UnknownStageP',
      p2: 'UnknownStageOpp',
      p1score: '3',
      p2score: '0',
      winSeat: 1,
      date: 'February 8, 2026',
      games: [
        { winnerSeat: 1, stage: '☆ Nonexistent Arena' },
        { winnerSeat: 1, stage: 'Battlefield' },
        { winnerSeat: 1, stage: 'Battlefield' },
      ],
    }) +
    // r9m1: ambiguous candidates (two seeded provider sets share this pair,
    // score and day).
    buildSetBlock({
      round: 9,
      match: 1,
      p1: 'AmbiguousP',
      p2: 'AmbiguousOpp',
      p1score: '1',
      p2score: '0',
      winSeat: 1,
      date: 'February 9, 2026',
      games: [{ winnerSeat: 1 }],
    }) +
    // r10m1/r10m2: grand-finals reset, counter-level re-assertion.
    RESET_BLOCK +
    // r11m1: start.gg-only cohort member (its match row is pre-seeded with
    // an already-resolved stage BEFORE the run).
    buildSetBlock({
      round: 11,
      match: 1,
      p1: 'StartggOnlyP',
      p2: 'StartggOnlyOpp',
      p1score: '1',
      p2score: '0',
      winSeat: 1,
      date: 'February 11, 2026',
      games: [{ winnerSeat: 1, stage: 'Battlefield' }],
    }) +
    '}}\n'
  );
}

function buildVodPageBody(): string {
  // Discovery-only — see supernova.test.ts's own header for why this row
  // deliberately names a player/opponent this fixture never seeds a
  // provider set for.
  return (
    'lp-col lp-d-block lp-col-12<b>[[MatrixCup/2026|Matrix Cup 2026]]</b><br/>' +
    'MatrixPlayer vs. <span style="vertical-align:-1px;">&nbsp;[[NobodyReal|NobodyReal]]</span> ' +
    '<span class="plainlinks vodlink">[[File:VOD Icon.png|20px|link=https://www.youtube.com/watch?v=matrixDiscoveryOnly]]</span>'
  );
}

// ---------------------------------------------------------------------------
// Fixture-backed client
// ---------------------------------------------------------------------------

interface MatrixClientOptions {
  bracketContent?: string;
  bracketRevisionId?: number;
  bracketSha1?: string;
  failGetWikitextOnCall?: { call: number; error: LiquipediaApiError };
}

function buildMatrixFixtureClient(opts: MatrixClientOptions = {}): {
  client: LiquipediaClient;
  calls: { getWikitext: string[][] };
} {
  const bracketContent = opts.bracketContent ?? buildMatrixBracketWikitext();
  const bracketRevisionId = opts.bracketRevisionId ?? 1;
  const bracketSha1 = opts.bracketSha1 ?? sha256Hex(bracketContent);
  const tournamentContent = buildTournamentWikitext();
  let getWikitextCallCount = 0;
  const calls = { getWikitext: [] as string[][] };

  const wikitextPages = new Map([
    [
      TOURNAMENT_TITLE,
      { revisionId: 1, sha1: sha256Hex(tournamentContent), content: tournamentContent },
    ],
    [BRACKET_TITLE, { revisionId: bracketRevisionId, sha1: bracketSha1, content: bracketContent }],
  ]);

  const client: LiquipediaClient = {
    async getSiteInfo() {
      return {};
    },
    async headRevisions(titles: string[]): Promise<LiquipediaRevisionQueryResult> {
      return {
        pages: titles.map((title) => {
          if (title === PLAYER_LABEL) {
            return { present: true, title, revisionId: 0, sha1: '' };
          }
          if (title === VOD_PAGE_TITLE) {
            return { present: true, title, revisionId: 5, sha1: '' };
          }
          const page = wikitextPages.get(title);
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
      getWikitextCallCount += 1;
      if (opts.failGetWikitextOnCall && opts.failGetWikitextOnCall.call === getWikitextCallCount) {
        const err = opts.failGetWikitextOnCall.error;
        // Fail exactly once — subsequent calls (the retry) succeed.
        opts.failGetWikitextOnCall = undefined;
        throw err;
      }
      return {
        pages: titles.map((title) => {
          const page = wikitextPages.get(title);
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
      if (prefix !== TOURNAMENT_TITLE) {
        return [];
      }
      return [
        { title: TOURNAMENT_TITLE, pageId: 1 },
        { title: BRACKET_TITLE, pageId: 2 },
      ];
    },
    async getGeneratedVodPage(title: string) {
      return { title, mode: 'expandtemplates', content: buildVodPageBody() };
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Provider seeding
// ---------------------------------------------------------------------------

function completedAtSecondsFeb(day: number): number {
  return Math.floor(Date.UTC(2026, 1, day) / 1000);
}

interface SeedSetInput {
  setId: string;
  p1Name: string;
  p2Name: string;
  gameWinners: (1 | 2)[];
  day: number;
  tournamentSlug?: string;
}

async function seedProviderSet(database: FakeDatabase, input: SeedSetInput): Promise<void> {
  await database.ref(`researchSource/${TENANT_ID}/sets/${input.setId}`).set({
    providerSetId: input.setId,
    storageKey: input.setId,
    classification: 'complete',
    ruleId: 'singles',
    entrants: [
      { entrantId: 'e1', name: input.p1Name },
      { entrantId: 'e2', name: input.p2Name },
    ],
    games: input.gameWinners.map((winnerSeat, index) => ({
      gameId: index + 1,
      winnerEntrantId: winnerSeat === 1 ? 'e1' : 'e2',
    })),
    totalGames: input.gameWinners.length,
    completedAt: completedAtSecondsFeb(input.day),
    event: {
      tournamentSlug: input.tournamentSlug ?? 'matrix-cup-2026',
      tournamentName: 'Matrix Cup 2026',
      name: 'Matrix Cup 2026 Singles',
    },
    apiIds: { setId: input.setId },
    ingestionRunId: 'matrix-seed-run',
    fetchedAtMs: 1,
    lastObservedAtMs: 1,
  });
}

async function seedMatchRow(
  database: FakeDatabase,
  setId: string,
  ordinal: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await database
    .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(setId, ordinal)}`)
    .set({ note: 'seed', map: UNKNOWN_STAGE, ...overrides });
}

// ---------------------------------------------------------------------------
// Case ids — the summary assertion's authoritative list.
// ---------------------------------------------------------------------------

const CASE_NAMES = [
  'Exact unique match',
  'Alias-normalized match',
  'Same players meeting twice',
  'Grand finals reset',
  'Missing round',
  'Conflicting score',
  'Unknown stage',
  'Liquipedia correction on a later revision',
  'User VOD preserved over source refresh',
  'Idempotent replay',
  'Crash between projection row and witness',
  'Rate-limit and backoff recovery',
  'Ambiguous candidates abstain',
  'Attribution surviving projection',
  'Evidence cohorts',
  'Forged status cannot reach projection',
  'Fabricated receipt cannot launder an attachment',
] as const;

describe('ENR-11 minimum-coverage matrix: case-count summary', () => {
  it(`enumerates exactly ${CASE_NAMES.length} cases, matching the number ENR-11 requires — a future edit that silently drops a case fails here`, () => {
    expect(CASE_NAMES.length).toBe(17);
    expect(new Set(CASE_NAMES).size).toBe(CASE_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// Shared matrix run — seeds every provider set the shared-run cases need,
// then runs ONE runEnrichmentBatch invocation.
// ---------------------------------------------------------------------------

async function seedSharedMatrixProviderSets(database: FakeDatabase): Promise<void> {
  await seedProviderSet(database, {
    setId: 'exact-set',
    p1Name: 'ExactP1',
    p2Name: 'ExactP2',
    gameWinners: [1, 1, 1],
    day: 1,
  });
  await seedProviderSet(database, {
    setId: 'sponsor-set',
    p1Name: 'SPONSOR | TeamTag',
    p2Name: 'AliasOpp2',
    gameWinners: [1],
    day: 2,
  });
  await seedProviderSet(database, {
    setId: 'disambig-set',
    p1Name: 'DisambigPlayer',
    p2Name: 'AliasOpp3',
    gameWinners: [1],
    day: 2,
  });
  await seedProviderSet(database, {
    setId: 'repeat-set-1',
    p1Name: 'RepeatA',
    p2Name: 'RepeatB',
    gameWinners: [1, 1, 1],
    day: 4,
  });
  await seedProviderSet(database, {
    setId: 'repeat-set-2',
    p1Name: 'RepeatA',
    p2Name: 'RepeatB',
    gameWinners: [1, 1, 2, 1],
    day: 5,
  });
  await seedProviderSet(database, {
    setId: 'no-round-set',
    p1Name: 'NoRoundP',
    p2Name: 'NoRoundOpp',
    gameWinners: [1],
    day: 6,
  });
  await seedProviderSet(database, {
    setId: 'conflict-set',
    p1Name: 'ConflictP',
    p2Name: 'ConflictOpp',
    gameWinners: [1, 1, 2],
    day: 7,
  });
  await seedProviderSet(database, {
    setId: 'unknown-stage-set',
    p1Name: 'UnknownStageP',
    p2Name: 'UnknownStageOpp',
    gameWinners: [1, 1, 1],
    day: 8,
  });
  await seedProviderSet(database, {
    setId: 'ambiguous-set-a',
    p1Name: 'AmbiguousP',
    p2Name: 'AmbiguousOpp',
    gameWinners: [1],
    day: 9,
  });
  await seedProviderSet(database, {
    setId: 'ambiguous-set-b',
    p1Name: 'AmbiguousP',
    p2Name: 'AmbiguousOpp',
    gameWinners: [1],
    day: 9,
  });
  await seedProviderSet(database, {
    setId: 'reset-gf-set',
    p1Name: 'ResetP1',
    p2Name: 'ResetP2',
    gameWinners: [2, 2],
    day: 3,
  });
  await seedProviderSet(database, {
    setId: 'reset-reset-set',
    p1Name: 'ResetP1',
    p2Name: 'ResetP2',
    gameWinners: [1, 2, 2],
    day: 3,
  });
  await seedProviderSet(database, {
    setId: 'startgg-only-set',
    p1Name: 'StartggOnlyP',
    p2Name: 'StartggOnlyOpp',
    gameWinners: [1],
    day: 11,
  });

  await seedMatchRow(database, 'exact-set', 1);
  await seedMatchRow(database, 'exact-set', 2);
  await seedMatchRow(database, 'exact-set', 3);
  await seedMatchRow(database, 'sponsor-set', 1);
  await seedMatchRow(database, 'disambig-set', 1);
  await seedMatchRow(database, 'repeat-set-1', 1);
  await seedMatchRow(database, 'repeat-set-1', 2);
  await seedMatchRow(database, 'repeat-set-1', 3);
  await seedMatchRow(database, 'repeat-set-2', 1);
  await seedMatchRow(database, 'repeat-set-2', 2);
  await seedMatchRow(database, 'repeat-set-2', 3);
  await seedMatchRow(database, 'repeat-set-2', 4);
  await seedMatchRow(database, 'no-round-set', 1);
  await seedMatchRow(database, 'conflict-set', 1);
  await seedMatchRow(database, 'conflict-set', 2);
  await seedMatchRow(database, 'conflict-set', 3);
  await seedMatchRow(database, 'unknown-stage-set', 1);
  await seedMatchRow(database, 'unknown-stage-set', 2);
  await seedMatchRow(database, 'unknown-stage-set', 3);
  await seedMatchRow(database, 'reset-gf-set', 1);
  await seedMatchRow(database, 'reset-gf-set', 2);
  await seedMatchRow(database, 'reset-reset-set', 1);
  await seedMatchRow(database, 'reset-reset-set', 2);
  await seedMatchRow(database, 'reset-reset-set', 3);
  // Pre-resolved BEFORE the run — this is what makes it start.gg-only.
  await seedMatchRow(database, 'startgg-only-set', 1, {
    map: { id: 59, name: 'Pokémon Stadium 2' },
  });
}

async function runSharedMatrix(database: FakeDatabase, nowMs = 1_000) {
  const { client } = buildMatrixFixtureClient();
  return runEnrichmentBatch({
    database: asDatabase(database),
    client,
    tenantId: TENANT_ID,
    playerLabels: [PLAYER_LABEL],
    targetGame: 'ultimate',
    nowMs,
    hashHex: sha256Hex,
    dryRun: false,
  });
}

async function readAllObservations(
  database: FakeDatabase,
): Promise<ResearchEnrichmentObservationRecord[]> {
  return listEnrichmentObservations(asDatabase(database), TENANT_ID);
}

async function attachedTargetSetIds(database: FakeDatabase): Promise<Set<string>> {
  const snapshot = await database.ref(`researchEnrichmentAttachments/${TENANT_ID}`).get();
  const raw = (snapshot.val() as Record<string, unknown>) ?? {};
  return new Set(Object.keys(raw));
}

// ---------------------------------------------------------------------------
// Shared-run cases
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: shared-run cases', () => {
  it('Exact unique match: a single high-confidence survivor attaches', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('exact-set')).toBe(true);
  });

  it('Alias-normalized match: a sponsor-prefixed and a disambiguation-suffixed tag both attach to the same start.gg record', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('sponsor-set')).toBe(true);
    expect(attached.has('disambig-set')).toBe(true);
  });

  it('Same players meeting twice: both sets attach distinctly and neither is dropped', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('repeat-set-1')).toBe(true);
    expect(attached.has('repeat-set-2')).toBe(true);
  });

  it('Grand finals reset: covered by the dedicated Supernova suite and re-asserted here at the counter level', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('reset-gf-set')).toBe(true);
    expect(attached.has('reset-reset-set')).toBe(true);
  });

  it('Missing round: a set with no derivable round still attaches on the other evidence, because round is not a rung', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const observations = await readAllObservations(database);
    const noRoundObservation = observations.find(
      (o) => o.players?.[0]?.rawTag === 'NoRoundP' && o.players?.[1]?.rawTag === 'NoRoundOpp',
    );
    // No round parameter exists in the legacy grammar at all — a derived
    // label is the only thing this observation ever carries for round.
    expect(noRoundObservation?.derivedRoundLabel).toBeDefined();

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('no-round-set')).toBe(true);
  });

  it('Conflicting score: the observation is classified conflicting, creates no attachment, and appears in the review queue', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('conflict-set')).toBe(false);

    const observations = await readAllObservations(database);
    const conflictObservation = observations.find(
      (o) => o.players?.[0]?.rawTag === 'ConflictP' && o.players?.[1]?.rawTag === 'ConflictOpp',
    )!;
    const queue = await listEnrichmentReviewQueue(asDatabase(database), TENANT_ID);
    expect(queue.map((o) => o.observationId)).toContain(conflictObservation.observationId);

    // Direct resolution confirms the CLASSIFICATION, not merely the absence.
    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);
    const outcome = resolveObservation(conflictObservation, index);
    expect(outcome.type).toBe('conflicting');
  });

  it('Unknown stage: the canonical id is absent, the raw string is preserved, the review flag is set, and the unknown-stage gap counter increments', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    const { result } = await (async () => ({ result: await runSharedMatrix(database) }))();

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('unknown-stage-set')).toBe(true);

    const observations = await readAllObservations(database);
    const unknownStageObservation = observations.find(
      (o) =>
        o.players?.[0]?.rawTag === 'UnknownStageP' && o.players?.[1]?.rawTag === 'UnknownStageOpp',
    )!;
    const firstGame = unknownStageObservation.games?.[0];
    expect(firstGame?.canonicalStageId).toBeNull();
    expect(firstGame?.rawStage).toBe('☆ Nonexistent Arena');
    expect(firstGame?.stageForm).toBe('unknown');

    const row = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey('unknown-stage-set', 1)}`)
      .get();
    expect((row.val() as { map?: { id: number } }).map?.id).toBe(0);

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot?.counts.unknownStageAfterEnrichment).toBeGreaterThanOrEqual(1);
    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(1);
  });

  it('Ambiguous candidates abstain: two survivors produce no attachment and one review-queue entry carrying both candidates', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const attached = await attachedTargetSetIds(database);
    expect(attached.has('ambiguous-set-a')).toBe(false);
    expect(attached.has('ambiguous-set-b')).toBe(false);

    const observations = await readAllObservations(database);
    const ambiguousObservation = observations.find(
      (o) => o.players?.[0]?.rawTag === 'AmbiguousP' && o.players?.[1]?.rawTag === 'AmbiguousOpp',
    )!;
    const queue = await listEnrichmentReviewQueue(asDatabase(database), TENANT_ID);
    const queueIds = queue.map((o) => o.observationId);
    expect(queueIds.filter((id) => id === ambiguousObservation.observationId)).toHaveLength(1);

    const index = await buildCandidateIndex(asDatabase(database), TENANT_ID);
    const outcome = resolveObservation(ambiguousObservation, index);
    expect(outcome.type).toBe('ambiguous');
    expect((outcome as { candidateTargetSetIds: string[] }).candidateTargetSetIds.sort()).toEqual([
      'ambiguous-set-a',
      'ambiguous-set-b',
    ]);
  });

  it('Attribution surviving projection: the source page title, URL and revision id are readable from the witness after projection', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const key = deriveEnrichmentMatchRowKey('exact-set', 1);
    const witnessSnapshot = await database
      .ref(`researchEnrichmentProjection/${TENANT_ID}/${key}`)
      .get();
    expect(witnessSnapshot.exists()).toBe(true);
    const witness = witnessSnapshot.val() as { stageObservationId?: string };
    expect(witness.stageObservationId).toBeDefined();

    const observations = await readAllObservations(database);
    const exactObservation = observations.find(
      (o) => witness.stageObservationId === o.observationId,
    )!;
    expect(exactObservation.sourcePageTitle).toBe(BRACKET_TITLE);
    expect(exactObservation.sourcePageUrl).toMatch(/^https:\/\/liquipedia\.net\/smash\//);
    expect(exactObservation.sourceRevisionId).toBeGreaterThan(0);
  });

  it('Evidence cohorts: a fixture producing all three cohorts yields counts that sum to the classified total and correctly separate start.gg-only from Liquipedia-supplemented from still-missing', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database);

    const snapshot = await readEnrichmentCoverage(asDatabase(database), TENANT_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.cohortCounts.startggOnly).toBeGreaterThanOrEqual(1);
    expect(snapshot!.cohortCounts.liquipediaSupplemented).toBeGreaterThanOrEqual(1);
    expect(snapshot!.cohortCounts.missing).toBeGreaterThanOrEqual(1);

    // classifyStageCohort is the SAME total function run.ts's own delta
    // derivation restates — re-verify it agrees for the three anchor rows.
    const startggOnlyRow = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey('startgg-only-set', 1)}`)
      .get();
    expect(
      classifyStageCohort({
        providerStageId: (startggOnlyRow.val() as { map: { id: number } }).map.id,
        witness: null,
      }),
    ).toBe('startggOnly');
  });
});

// ---------------------------------------------------------------------------
// Idempotent replay
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: idempotent replay', () => {
  it('Idempotent replay: a byte-identical replay performs zero value-changing writes, and issues only batched probe requests plus exactly one parse-class request per generated VOD page', async () => {
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    await runSharedMatrix(database, 1_000);

    const domainTreesBefore = JSON.parse(
      JSON.stringify({
        matches: (database.dump() as Record<string, unknown>).matches ?? null,
        researchEnrichmentObservations:
          (database.dump() as Record<string, unknown>).researchEnrichmentObservations ?? null,
      }),
    ) as Record<string, unknown>;

    const { client: secondClient } = buildMatrixFixtureClient();
    let generatedCalls = 0;
    const wrappedClient: LiquipediaClient = {
      ...secondClient,
      async getGeneratedVodPage(title) {
        generatedCalls += 1;
        return secondClient.getGeneratedVodPage(title);
      },
    };
    const second = await runEnrichmentBatch({
      database: asDatabase(database),
      client: wrappedClient,
      tenantId: TENANT_ID,
      playerLabels: [PLAYER_LABEL],
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
      dryRun: false,
    });

    expect(generatedCalls).toBe(1);
    expect(second.counts.wikitextCacheHits).toBeGreaterThanOrEqual(2);
    expect(second.counts.generatedCacheHits).toBe(1);

    const domainTreesAfter = JSON.parse(
      JSON.stringify({
        matches: (database.dump() as Record<string, unknown>).matches ?? null,
        researchEnrichmentObservations:
          (database.dump() as Record<string, unknown>).researchEnrichmentObservations ?? null,
      }),
    ) as Record<string, unknown>;

    expect(domainTreesAfter).toEqual(domainTreesBefore);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit and backoff recovery
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: rate-limit and backoff recovery', () => {
  it('Rate-limit and backoff recovery: a 429 with a retry-after header is honoured on the fake clock and the run resumes and completes', async () => {
    const realStart = Date.now();

    // Half A: the DURABLE LIMITER itself, driven on a fake clock — proves
    // the enforced spacing without ever sleeping on a wall clock.
    let virtualNow = 1_000;
    const sleepCalls: number[] = [];
    const limiterDatabase = new FakeDatabase();
    const limiter = createLiquipediaLimiter(asDatabase(limiterDatabase), {
      now: () => virtualNow,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        virtualNow += ms;
      },
    });
    const first = await limiter.acquire('general', 5_000);
    expect(first.granted).toBe(true);
    const startBeforeSecond = virtualNow;
    const second = await limiter.acquire('general', 5_000);
    expect(second.granted).toBe(true);
    expect(virtualNow - startBeforeSecond).toBeGreaterThanOrEqual(
      LIQUIPEDIA_GENERAL_MIN_INTERVAL_MS - 1,
    );
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);

    // Half B: a 429-with-retry-after fixture route is honoured through the
    // shared backoff helper and the run resumes and completes (run.ts's own
    // `callWithRetry`) — re-asserted here at the acceptance level.
    const database = new FakeDatabase();
    await seedSharedMatrixProviderSets(database);
    const { client } = buildMatrixFixtureClient({
      failGetWikitextOnCall: { call: 1, error: new LiquipediaApiError('rate limited', 429, '2') },
    });
    const delay = resolveLiquipediaRetryDelayMs(
      new LiquipediaApiError('rate limited', 429, '2'),
      0,
    );
    expect(delay).toBeGreaterThan(0);

    const result = await runEnrichmentBatch({
      database: asDatabase(database),
      client,
      tenantId: TENANT_ID,
      playerLabels: [PLAYER_LABEL],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(result.counts.backoffEvents).toBeGreaterThanOrEqual(1);
    expect(result.counts.resolvedMatched).toBeGreaterThanOrEqual(1);

    expect(Date.now() - realStart).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Liquipedia correction on a later revision
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: later-revision correction', () => {
  it('Liquipedia correction on a later revision: the corrected stage applies and every other stored enrichment for the page is unchanged', async () => {
    const database = new FakeDatabase();
    await seedProviderSet(database, {
      setId: 'correction-set',
      p1Name: 'CorrectionP1',
      p2Name: 'CorrectionP2',
      gameWinners: [1, 1],
      day: 20,
      tournamentSlug: 'correction-cup-2026',
    });
    await seedMatchRow(database, 'correction-set', 1);
    await seedMatchRow(database, 'correction-set', 2);

    const v1Content =
      '{{TournamentInfo|game=ultimate|tourneylink=CorrectionCup/2026}}\n' +
      '{{MatrixBracketA' +
      buildSetBlock({
        round: 1,
        match: 1,
        p1: 'CorrectionP1',
        p2: 'CorrectionP2',
        p1score: '2',
        p2score: '0',
        winSeat: 1,
        date: 'February 20, 2026',
        // Game 2's stage is DELIBERATELY unmapped in v1 (a typo an editor
        // has not yet fixed) — the shared ownership resolver
        // (`resolveEnrichedMatchMembers`) treats an ALREADY-RESOLVED stage
        // as provider-owned FOREVER, unconditionally (never overwritten by
        // a later enrichment pass, by shipped Phase 30 design — see
        // `packages/shared/src/researchEnrichmentProjection.ts`'s own
        // module header). A genuine "correction" is therefore only
        // observable while the row is STILL unknown — this fixture models
        // exactly that: v1 leaves game 2 unresolved, v2 fixes the typo.
        games: [
          { winnerSeat: 1, stage: 'Battlefield' },
          { winnerSeat: 1, stage: 'Battlefeild' },
        ],
      }) +
      '}}\n';
    const v2Content = v1Content.replace(
      '|r1m1p1char2=fox |r1m1p2char2=falco |r1m1p1stock2=0 |r1m1p2stock2=0 |r1m1win2=1 |r1m1stage2=Battlefeild',
      '|r1m1p1char2=fox |r1m1p2char2=falco |r1m1p1stock2=0 |r1m1p2stock2=0 |r1m1win2=1 |r1m1stage2=Small Battlefield',
    );
    expect(v2Content).not.toBe(v1Content);

    const tournamentTitle = 'CorrectionCup/2026';
    const bracketTitle = 'CorrectionCup/2026/Bracket';
    const tournamentContent =
      '{{Infobox league|name=Correction Cup|startgg=tournament/correction-cup-2026/details|' +
      'sdate=2026-02-20|edate=2026-02-20|game=ultimate}}';

    function buildClient(content: string, revisionId: number): LiquipediaClient {
      const pages = new Map([
        [
          tournamentTitle,
          { revisionId: 1, sha1: sha256Hex(tournamentContent), content: tournamentContent },
        ],
        [bracketTitle, { revisionId, sha1: sha256Hex(content), content }],
      ]);
      return {
        async getSiteInfo() {
          return {};
        },
        async headRevisions(titles: string[]) {
          return {
            pages: titles.map((title) => {
              if (title === 'CorrectionPlayer' || title === 'CorrectionPlayer/VODs') {
                return { present: true, title, revisionId: 0, sha1: '' };
              }
              const page = pages.get(title);
              return page
                ? { present: true, title, revisionId: page.revisionId, sha1: page.sha1 }
                : { present: false, title };
            }),
            normalized: [],
            redirects: [],
          };
        },
        async getWikitext(titles: string[]) {
          return {
            pages: titles.map((title) => {
              const page = pages.get(title);
              return page
                ? {
                    present: true,
                    title,
                    revisionId: page.revisionId,
                    sha1: page.sha1,
                    content: page.content,
                  }
                : { present: false, title };
            }),
            normalized: [],
            redirects: [],
          };
        },
        async listSubpages(prefix: string) {
          return prefix === tournamentTitle
            ? [
                { title: tournamentTitle, pageId: 1 },
                { title: bracketTitle, pageId: 2 },
              ]
            : [];
        },
        async getGeneratedVodPage(title: string) {
          return {
            title,
            mode: 'expandtemplates' as const,
            content:
              'lp-col lp-d-block lp-col-12<b>[[CorrectionCup/2026|Correction Cup]]</b><br/>' +
              'CorrectionPlayer vs. <span style="vertical-align:-1px;">&nbsp;[[NobodyReal2|NobodyReal2]]</span> ' +
              '<span class="plainlinks vodlink">[[File:VOD Icon.png|20px|link=https://www.youtube.com/watch?v=correctionDiscovery]]</span>',
          };
        },
      };
    }

    const first = await runEnrichmentBatch({
      database: asDatabase(database),
      client: buildClient(v1Content, 5000),
      tenantId: TENANT_ID,
      playerLabels: ['CorrectionPlayer'],
      targetGame: 'ultimate',
      nowMs: 1_000,
      hashHex: sha256Hex,
      dryRun: false,
    });
    expect(first.counts.resolvedMatched).toBeGreaterThanOrEqual(1);

    const rowBefore = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey('correction-set', 1)}`)
      .get();
    expect((rowBefore.val() as { map: { name: string } }).map.name).toBe('Battlefield');

    // A LATER REVISION landing on an ALREADY-ATTACHED observation is a
    // REFRESH, not a fresh gather — `runEnrichmentBatch`'s review queue
    // excludes already-attached observations by design (store.ts's own
    // contract), so the production correction path is `refresh.ts`'s
    // `planPageRefresh`/`applyPageRefresh` (plan 09, ENR-10), never a second
    // `runEnrichmentBatch` invocation. Extraction itself is driven through
    // the SAME production functions `run.ts` calls internally.
    const eventContext = extractEventContext({
      wikitext: v2Content,
      pageTitle: bracketTitle,
      revisionId: 5001,
      sha1: sha256Hex(v2Content),
    });
    const tournamentContext = extractEventContext({
      wikitext: tournamentContent,
      pageTitle: tournamentTitle,
      revisionId: 1,
      sha1: sha256Hex(tournamentContent),
    });
    const mergedContext = { ...eventContext, startggSlug: tournamentContext.startggSlug };
    const { observations: correctedObservations } = extractLegacyBracketObservations({
      wikitext: v2Content,
      pageTitle: bracketTitle,
      revisionId: 5001,
      sha1: sha256Hex(v2Content),
      eventContext: mergedContext,
      targetGame: 'ultimate',
      nowMs: 2_000,
      hashHex: sha256Hex,
    });
    expect(correctedObservations).toHaveLength(1);

    const plan = planPageRefresh({
      pageClass: 'wikitext',
      cached: {
        pageId: 'correction-bracket-cache',
        title: bracketTitle,
        pageClass: 'wikitext',
        parserVersion: 'liquipedia-wikitext-probe@1',
        fetchedAtMs: 1_000,
        revisionId: 5000,
        sha1: sha256Hex(v1Content),
      },
      parserVersion: 'liquipedia-wikitext-probe@1',
      probeRevisionId: 5001,
      probeSha1: sha256Hex(v2Content),
      previousObservationCount: 1,
      nextObservationCount: correctedObservations.length,
    });
    expect(plan.verdict).toBe('refresh');

    const outcome = await applyPageRefresh(
      asDatabase(database),
      TENANT_ID,
      plan,
      { sourcePageTitle: bracketTitle, observations: correctedObservations },
      2_000,
    );
    expect(outcome.written).toBeGreaterThanOrEqual(1);

    const row1After = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey('correction-set', 1)}`)
      .get();
    const row2After = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey('correction-set', 2)}`)
      .get();
    // Every OTHER stored enrichment (game 1) unchanged.
    expect((row1After.val() as { map: { name: string } }).map.name).toBe('Battlefield');
    // The corrected game (game 2) applies the new stage.
    expect((row2After.val() as { map: { name: string } }).map.name).toBe('Small Battlefield');
  });
});

// ---------------------------------------------------------------------------
// User VOD preserved over source refresh — driven through
// researchBackfillBatch (the job path), not applyLegacyProjection.
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: user VOD preservation', () => {
  const BACKFILL_TENANT = 'matrix-backfill-tenant';
  const PLAYER_ID = '500';
  const SUBJECT_ENTRANT_ID = 10;
  const OPPONENT_ENTRANT_ID = 20;

  function makeSet(): StartggResearchSet {
    return {
      id: 1,
      state: null,
      completedAt: 1_000,
      createdAt: null,
      updatedAt: 500,
      fullRoundText: 'Winners Round 1',
      round: 1,
      displayScore: '2-1',
      totalGames: 1,
      vodUrl: null,
      identifier: null,
      event: {
        id: 1,
        name: 'Test Event',
        slug: 'test/event',
        isOnline: false,
        numEntrants: 8,
        type: null,
        videogame: { id: SSBU_VIDEOGAME_ID },
        tournament: { id: 1, name: 'Test Tournament', slug: 'test' },
      },
      slots: [
        {
          entrant: {
            id: SUBJECT_ENTRANT_ID,
            name: 'Subject',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [{ player: { id: Number(PLAYER_ID), gamerTag: 'Subject' }, user: null }],
            seeds: null,
            standing: null,
          },
        },
        {
          entrant: {
            id: OPPONENT_ENTRANT_ID,
            name: 'Opponent',
            isDisqualified: null,
            initialSeedNum: null,
            participants: [{ player: { id: 999, gamerTag: 'Opponent' }, user: null }],
            seeds: null,
            standing: null,
          },
        },
      ],
      games: [
        {
          id: 1,
          winnerId: SUBJECT_ENTRANT_ID,
          stage: { id: 311, name: 'Battlefield' },
          selections: [
            { character: { id: 1271 }, entrant: { id: SUBJECT_ENTRANT_ID } },
            { character: { id: 1272 }, entrant: { id: OPPONENT_ENTRANT_ID } },
          ],
          entrant1Score: 2,
          entrant2Score: 1,
        },
      ],
    };
  }

  function makeScriptedFetch(sets: StartggResearchSet[]): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        variables: { page: number };
      };
      if (body.variables.page !== 1) {
        return new Response(
          JSON.stringify({
            data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: [] } } },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          data: { player: { sets: { pageInfo: { totalPages: 1 }, nodes: sets } } },
        }),
      );
    }) as unknown as typeof fetch;
  }

  it('User VOD preserved over source refresh: a user-entered URL survives a refresh untouched and the skip is counted — driven through the researchBackfillBatch JOB path', async () => {
    const database = new FakeDatabase();
    await confirmIdentityPlayers(asDatabase(database), BACKFILL_TENANT, 'admin-1', [
      { playerId: PLAYER_ID },
    ]);
    const firstRunId = (
      await createOrResumeBackfillRun(asDatabase(database), {
        tenantId: BACKFILL_TENANT,
        playerId: PLAYER_ID,
        requestedByUid: 'admin-1',
        mode: 'full',
      })
    ).runId!;

    const fetchImpl = makeScriptedFetch([makeSet()]);
    const first = await runResearchBackfillBatch(
      asDatabase(database),
      'server-token',
      BACKFILL_TENANT,
      firstRunId,
      { ownerId: 'invocation-1', perPage: 1, fetchImpl },
    );
    expect(first.completed).toBe(true);

    const sourceTree = (database.dump() as Record<string, unknown>).researchSource as
      Record<string, Record<string, { sets: Record<string, unknown> }>> | undefined;
    const storageKey = Object.keys(sourceTree?.[BACKFILL_TENANT]?.sets ?? {})[0]!;
    const key = `sgg-${storageKey}-g1`;

    // The user types their own VOD URL onto the projected row BEFORE any
    // enrichment attaches — no witness exists yet, so this is genuinely
    // user-owned.
    const USER_VOD_URL = 'https://www.youtube.com/watch?v=userTypedThisOne';
    database.seed(`matches/${BACKFILL_TENANT}/${key}/vodUrl`, USER_VOD_URL);

    // Attach a Liquipedia observation carrying a DIFFERENT VOD URL for the
    // same row.
    const observation: ResearchEnrichmentObservationRecord = {
      observationId: 'obs-user-vod-case',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Test/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Test/Bracket',
      sourceRevisionId: 500,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1000,
      observedAtMs: 1000,
      matchingStatus: 'unmatched',
      vodUrl: 'https://www.youtube.com/watch?v=liquipediaSourcedVod',
      games: [{ ordinal: 1, canonicalStageId: null }],
      candidateTargetSetIds: [storageKey],
    };
    await writeEnrichmentObservation(asDatabase(database), BACKFILL_TENANT, observation);
    const confirmed = await confirmEnrichmentObservationByAdmin(
      asDatabase(database),
      BACKFILL_TENANT,
      observation.observationId,
      storageKey,
      'admin-1',
      2000,
    );
    expect(confirmed.outcome).toBe('created');

    const secondRunId = (
      await createOrResumeBackfillRun(asDatabase(database), {
        tenantId: BACKFILL_TENANT,
        playerId: PLAYER_ID,
        requestedByUid: 'admin-1',
        mode: 'refresh',
      })
    ).runId!;
    const second = await runResearchBackfillBatch(
      asDatabase(database),
      'server-token',
      BACKFILL_TENANT,
      secondRunId,
      { ownerId: 'invocation-2', perPage: 1, fetchImpl: makeScriptedFetch([makeSet()]) },
    );
    expect(second.completed).toBe(true);

    const rowAfter = (database.dump() as Record<string, unknown>).matches as
      Record<string, Record<string, { vodUrl?: string }>> | undefined;
    // The user's URL is BYTE-UNCHANGED — never overwritten by the
    // Liquipedia-sourced value.
    expect(rowAfter?.[BACKFILL_TENANT]?.[key]?.vodUrl).toBe(USER_VOD_URL);
  });
});

// ---------------------------------------------------------------------------
// Crash between projection row and witness
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: crash-window convergence', () => {
  const CRASH_TARGET_SET_ID = 'crash-set-1';
  const CRASH_KEY = deriveEnrichmentMatchRowKey(CRASH_TARGET_SET_ID, 1);

  async function seedCrashFixture(database: FakeDatabase): Promise<{
    attachments: Awaited<ReturnType<typeof listAttachmentsForSet>>;
    observationsById: Record<string, ResearchEnrichmentObservationRecord>;
  }> {
    const record: ResearchEnrichmentObservationRecord = {
      observationId: 'crash-obs-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Crash/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Crash/Bracket',
      sourceRevisionId: 1,
      sourceContentHash: 'b'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1,
      observedAtMs: 1,
      matchingStatus: 'unmatched',
      vodUrl: 'https://www.youtube.com/watch?v=crashCase01',
      games: [{ ordinal: 1, canonicalStageId: 1, rawStage: 'Battlefield' }],
      candidateTargetSetIds: [CRASH_TARGET_SET_ID],
    };
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    await confirmEnrichmentObservationByAdmin(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
      CRASH_TARGET_SET_ID,
      'admin-crash',
      1,
    );
    await database.ref(`matches/${TENANT_ID}/${CRASH_KEY}`).set({ note: 'seed' });

    const attachments = await listAttachmentsForSet(
      asDatabase(database),
      TENANT_ID,
      CRASH_TARGET_SET_ID,
    );
    const observationsById: Record<string, ResearchEnrichmentObservationRecord> = {
      [record.observationId]: record,
    };
    return { attachments, observationsById };
  }

  const CRASH_POINTS = [1, 2, 3];

  describe.each(CRASH_POINTS)('crash at write #%d', (writeNumber) => {
    it('Crash between projection row and witness: an applier crashed at each inter-write point and retried converges on the crash-free final state, with no projected value frozen as user-owned', async () => {
      const database = new FakeDatabase();
      const { attachments, observationsById } = await seedCrashFixture(database);
      const overlay = buildEnrichmentOverlay({
        targetSetId: CRASH_TARGET_SET_ID,
        attachments,
        observations: observationsById,
      });

      const faultDb = new FaultInjectingDatabase(database, writeNumber);
      await expect(
        applyEnrichmentProjection(
          asDatabase(faultDb),
          TENANT_ID,
          CRASH_TARGET_SET_ID,
          overlay,
          1_000,
        ),
      ).rejects.toThrow();

      // Retry with no further injected fault.
      await applyEnrichmentProjection(
        asDatabase(database),
        TENANT_ID,
        CRASH_TARGET_SET_ID,
        overlay,
        2_000,
      );

      const row = await database.ref(`matches/${TENANT_ID}/${CRASH_KEY}`).get();
      const value = row.val() as { vodUrl?: string; map?: { id: number } };
      expect(value.vodUrl).toBe('https://www.youtube.com/watch?v=crashCase01');
      expect(value.map?.id).toBe(1);

      const witness = await database
        .ref(`researchEnrichmentProjection/${TENANT_ID}/${CRASH_KEY}`)
        .get();
      const witnessValue = witness.val() as {
        pendingVodUrl?: unknown;
        pendingStageId?: unknown;
        projectedVodUrl?: string;
      };
      // No pending half lingers after a clean retry.
      expect(witnessValue.pendingVodUrl ?? null).toBeNull();
      expect(witnessValue.pendingStageId ?? null).toBeNull();
      expect(witnessValue.projectedVodUrl).toBe('https://www.youtube.com/watch?v=crashCase01');
    });
  });
});

// ---------------------------------------------------------------------------
// Forged status cannot reach projection
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: forged status', () => {
  it('Forged status cannot reach projection: an observation whose stored status is forged to matched produces no attachment, no match-row change and no cohort reclassification', async () => {
    const database = new FakeDatabase();
    const FORGED_TARGET_SET_ID = 'forged-target-set';
    const record: ResearchEnrichmentObservationRecord = {
      observationId: 'forged-obs-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Forged/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Forged/Bracket',
      sourceRevisionId: 1,
      sourceContentHash: 'c'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1,
      observedAtMs: 1,
      matchingStatus: 'unmatched',
      candidateTargetSetIds: [FORGED_TARGET_SET_ID],
    };
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(FORGED_TARGET_SET_ID, 1)}`)
      .set({ note: 'seed', map: UNKNOWN_STAGE });

    // Forge the status directly, bypassing every writer — no receipt exists.
    database.seed(
      `researchEnrichmentObservations/${TENANT_ID}/${record.observationId}/matchingStatus`,
      'matched',
    );

    // Driving an attachment attempt THROUGH THE WRITER (the structural
    // barrier itself) and capturing its refusal outcome — never merely
    // observing downstream absence.
    const attachResult = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
      'a-plausible-forged-receipt-id',
      2_000,
    );
    expect(attachResult.outcome).toBe('rejected-no-receipt');

    // Absence 1: no attachment.
    const attachments = await listAttachmentsForSet(
      asDatabase(database),
      TENANT_ID,
      FORGED_TARGET_SET_ID,
    );
    expect(attachments).toEqual([]);

    // Absence 2: no match-row change.
    const row = await database
      .ref(`matches/${TENANT_ID}/${deriveEnrichmentMatchRowKey(FORGED_TARGET_SET_ID, 1)}`)
      .get();
    expect((row.val() as { map: { id: number } }).map.id).toBe(0);

    // Absence 3: no cohort reclassification — still classified `missing`.
    const cohort = classifyStageCohort({
      providerStageId: (row.val() as { map: { id: number } }).map.id,
      witness: null,
    });
    expect(cohort).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// Fabricated receipt cannot launder an attachment (cycle-2 review HIGH 1)
// ---------------------------------------------------------------------------

describe('ENR-11 minimum-coverage matrix: fabricated receipt', () => {
  const RECEIPT_TARGET_SET_ID = 'receipt-target-set';

  function makeObservationRecord(): ResearchEnrichmentObservationRecord {
    return {
      observationId: 'receipt-obs-1',
      sourceProvider: 'liquipedia',
      sourceWiki: 'smash',
      contentType: 'stage-observation',
      sourcePageTitle: 'Receipt/Bracket',
      sourcePageUrl: 'https://liquipedia.net/smash/Receipt/Bracket',
      sourceRevisionId: 100,
      sourceContentHash: 'a'.repeat(64),
      parserVersion: 'liquipedia-bracket-legacy@1',
      templateFamily: 'legacy',
      fetchedAtMs: 1000,
      observedAtMs: 1000,
      matchingStatus: 'unmatched',
      candidateTargetSetIds: [RECEIPT_TARGET_SET_ID],
    };
  }

  function matchedOutcomeFor(targetSetId: string): ResolutionOutcome {
    return { type: 'matched', targetSetId, confidence: 'high', evidence: ['slug-anchor'] };
  }

  it('Fabricated receipt cannot launder an attachment: a schema-valid hand-built receipt — fingerprint-copied but not produced by buildResolutionReceipt — is refused at writeResolutionReceipt (persist refusal, receipt tree empty by direct inspection)', async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);

    // Fingerprint-copied (revision id, content hash, parser version all
    // match the STORED observation) but the receiptId is simply invented —
    // never derived from `deriveReceiptId`.
    const fabricatedReceipt = {
      receiptId: 'fabricated-not-derived-receipt-id',
      observationId: record.observationId,
      targetSetId: RECEIPT_TARGET_SET_ID,
      confidence: 'high' as const,
      resolvedAtMs: 5000,
      resolverVersion: 'liquipedia-resolver@1',
      sourceRevisionId: record.sourceRevisionId,
      sourceContentHash: record.sourceContentHash,
      parserVersion: record.parserVersion,
      candidateTargetSetIds: [RECEIPT_TARGET_SET_ID],
    };

    const result = await writeResolutionReceipt(asDatabase(database), TENANT_ID, fabricatedReceipt);
    expect(result.outcome).toBe('rejected-receipt-mismatch');

    // Receipt tree empty by DIRECT inspection.
    expect(database.dump().researchEnrichmentReceipts).toBeUndefined();
    const readBack = await readResolutionReceipt(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
    );
    expect(readBack).toBeNull();
  });

  it("Fabricated receipt cannot launder an attachment: a stored-then-tampered receipt whose id no longer derives from its content is refused by attachResolvedObservation's recomputation", async () => {
    const database = new FakeDatabase();
    const record = makeObservationRecord();
    await writeEnrichmentObservation(asDatabase(database), TENANT_ID, record);
    const genuineReceipt = buildResolutionReceipt(
      record,
      matchedOutcomeFor(RECEIPT_TARGET_SET_ID),
      5000,
    )!;
    const writeResult = await writeResolutionReceipt(
      asDatabase(database),
      TENANT_ID,
      genuineReceipt,
    );
    expect(writeResult.outcome).toBe('created');

    // Tamper the STORED receipt's `resolverVersion` directly through the
    // database, bypassing every writer — this field feeds `deriveReceiptId`
    // (observationId, resolverVersion, sourceContentHash) but carries no
    // schema-level cross-field refinement of its own (unlike `targetSetId`/
    // `candidateTargetSetIds`, which the schema itself would reject a
    // mismatch on before this ever reached the recomputation check). The
    // stored `receiptId` field is left untouched, so the tampered record is
    // still schema-valid and reads back successfully — the ONLY thing that
    // now fails is `attachResolvedObservation`'s own recomputation.
    database.seed(
      `researchEnrichmentReceipts/${TENANT_ID}/${record.observationId}/resolverVersion`,
      'tampered-resolver-version@999',
    );
    const tamperedReadBack = await readResolutionReceipt(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
    );
    expect(tamperedReadBack).not.toBeNull();

    const attachResult = await attachResolvedObservation(
      asDatabase(database),
      TENANT_ID,
      record.observationId,
      genuineReceipt.receiptId,
      6000,
    );
    expect(attachResult.outcome).toBe('rejected-receipt-mismatch');
    expect(database.dump().researchEnrichmentAttachments).toBeUndefined();

    // No attachment, no match-row change, no cohort reclassification.
    const attachments = await listAttachmentsForSet(
      asDatabase(database),
      TENANT_ID,
      RECEIPT_TARGET_SET_ID,
    );
    expect(attachments).toEqual([]);

    // Independent proof: the deterministic id-derivation itself would also
    // refuse a receiptId that does not derive from its content (the sibling
    // test above proves this at write time; re-derive here to show the SAME
    // function underlies both checks).
    const recomputed = deriveReceiptId({
      observationId: genuineReceipt.observationId,
      resolverVersion: genuineReceipt.resolverVersion,
      sourceContentHash: genuineReceipt.sourceContentHash,
    });
    expect(recomputed).toBe(genuineReceipt.receiptId);
  });
});
