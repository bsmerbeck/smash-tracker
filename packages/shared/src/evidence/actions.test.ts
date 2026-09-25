import { describe, expect, it } from 'vitest';
import {
  buildActionCandidates,
  DRILL_TEMPLATE_TABLE,
  MAX_RECOMMENDED_ACTIONS,
  rankActionCandidates,
  selectTopActions,
  type ActionInput,
  type VodRef,
} from './actions.js';
import { buildClaimSet, type ClaimAtom, type ClaimPredicate, type ClaimSubject } from './claims.js';
import type { EvidenceRow } from './snapshot.js';
import { vodEvidenceId } from './snapshot.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CONFIDENCE_TIER_BOUNDS,
  EVIDENCE_POLICY_VERSION,
  PRACTICE_STAGE_MIN_GAMES,
  confidenceTierFor,
} from './policy.js';
import type { ClaimValue, SampleMeta } from './types.js';

/**
 * RPT-09/D-12/D-18 (phase 39 plan 05): the deterministic recommended-action
 * engine. Task 1 exercises `matchup_practice` end-to-end plus the full
 * ranking/selection scaffolding every later kind inherits; Task 2 adds
 * `vod_review` and the D-18 drill-template table; Task 3 pins the
 * collapse/empty/ordering/overflow edge law.
 *
 * Claim fixtures are built through `buildClaimSet` over hand-constructed
 * `EvidenceRow`s — the same fixture-construction discipline
 * `claims.test.ts` establishes — rather than a second, independent claim
 * constructor.
 */

const REFRESHED_AT = 1_700_000_500_000;

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

function sampleFor(games: number): SampleMeta {
  return {
    rawSampleSize: games,
    eligibleDenominator: games,
    knownFieldCoverage: games === 0 ? 0 : 1,
    dateRange:
      games === 0 ? null : { firstMs: REFRESHED_AT - games * 60_000, lastMs: REFRESHED_AT },
    refreshedAt: REFRESHED_AT,
    evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
    recencyTreatment: 'unweighted',
    confidenceTier: confidenceTierFor(games),
  };
}

function row(
  predicate: ClaimPredicate,
  subject: ClaimSubject,
  value: ClaimValue,
  games: number,
): EvidenceRow {
  return { predicate, subject, value, sample: sampleFor(games) };
}

/** Builds a `ClaimAtom[]` from hand-built rows via the real `buildClaimSet` — never a second, ad-hoc claim constructor. */
function claimsFrom(rows: Record<string, EvidenceRow>): readonly ClaimAtom[] {
  return buildClaimSet({ rows, surface: 'prep_report' }).claims;
}

function emptyInput(): ActionInput {
  return { claims: [], vodRefs: [] };
}

describe('buildActionCandidates: matchup_practice', () => {
  it('a losing character_matchup_record claim at or above the practice floor yields one matchup_practice candidate citing that claim', () => {
    const games = CONFIDENCE_TIER_BOUNDS.medium;
    const subject: ClaimSubject = {
      ...NULL_SUBJECT,
      myFighterId: 8,
      opponentFighterId: 23,
      opponentTag: 'ExampleTag',
    };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 2, losses: games - 2, games },
        games,
      ),
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;

    const candidates = buildActionCandidates({ claims, vodRefs: [] });

    // The same claim also satisfies the matchup_punish drill condition (same
    // shape) — buildActionCandidates emits both RAW candidates; the D-18
    // non-duplication suppression that keeps only the matchup_practice one
    // is rankActionCandidates's job (see "D-18 non-duplication" below).
    const matchupPractice = candidates.filter((c) => c.kind === 'matchup_practice');
    expect(matchupPractice).toHaveLength(1);
    expect(matchupPractice[0]!.claimIds).toEqual([claim.id]);
  });

  it('the candidate carries a door target expressed as axes, never a URL, and every field is a plain value (no string starts with "/")', () => {
    const games = 5;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
    });

    const [candidate] = buildActionCandidates({ claims, vodRefs: [] });

    expect(candidate!.target).toEqual({
      kind: 'matchup',
      myFighterId: 8,
      opponentFighterId: 23,
      stageId: null,
      opponentTag: null,
      matchId: null,
    });
    for (const value of Object.values(candidate!)) {
      if (typeof value === 'string') {
        expect(value.startsWith('/')).toBe(false);
      }
    }
  });

  it('a claim below the practice floor produces no candidate', () => {
    const games = ABSTENTION_FLOOR_GAMES - 1;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 0, losses: games, games },
        games,
      ),
    });
    // a sub-floor row is itself abstained by buildClaimSet — confirm the fixture is what it claims to be.
    expect(claims[0]!.value.kind).toBe('abstained');

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    expect(candidates).toEqual([]);
  });

  it('an abstained claim produces no candidate', () => {
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 0, losses: 1, games: 1 },
        1,
      ),
    });
    expect(claims[0]!.value.kind).toBe('abstained');

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    expect(candidates).toEqual([]);
  });

  it('a winning matchup record (not losing) produces no matchup_practice candidate', () => {
    const games = 8;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 6, losses: 2, games },
        games,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    expect(candidates).toEqual([]);
  });
});

describe('rankActionCandidates: determinism', () => {
  function buildRows(): Record<string, EvidenceRow> {
    return {
      'cmr-f8-g23': row(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 },
        { kind: 'record', wins: 2, losses: 8, games: 10 },
        10,
      ),
      'cmr-f9-g24': row(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: 9, opponentFighterId: 24 },
        { kind: 'record', wins: 1, losses: 4, games: 5 },
        5,
      ),
    };
  }

  it('ranking the same claim set twice produces the same ordered candidate list, including action-id assignment', () => {
    const claims = claimsFrom(buildRows());
    const first = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));
    const second = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));

    expect(second).toEqual(first);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });

  it('a worse losing gap ranks above a smaller one', () => {
    const claims = claimsFrom(buildRows());
    const ranked = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));

    expect(ranked).toHaveLength(2);
    // f8 vs g23: 2-8 (gap 6); f9 vs g24: 1-4 (gap 3) — the bigger gap ranks first.
    expect(ranked[0]!.target.opponentFighterId).toBe(23);
    expect(ranked[1]!.target.opponentFighterId).toBe(24);
  });
});

describe('selectTopActions', () => {
  it('caps at MAX_RECOMMENDED_ACTIONS by default and is a prefix of the ranked list', () => {
    const rows: Record<string, EvidenceRow> = {};
    for (let index = 0; index < 5; index += 1) {
      rows[`cmr-f${index}-g${index}`] = row(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: index, opponentFighterId: index },
        { kind: 'record', wins: 0, losses: 4 + index, games: 4 + index },
        4 + index,
      );
    }
    const claims = claimsFrom(rows);
    const ranked = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));
    const selected = selectTopActions(ranked);

    expect(selected).toHaveLength(MAX_RECOMMENDED_ACTIONS);
    expect(ranked.slice(0, MAX_RECOMMENDED_ACTIONS)).toEqual(selected);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(selectTopActions(rankActionCandidates(buildActionCandidates(emptyInput())))).toEqual([]);
  });
});

describe('buildActionCandidates: vod_review', () => {
  it('a claim whose opponent axes match a lost VodRef yields one vod_review candidate citing that claim', () => {
    const games = 6;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 5, losses: 1, games },
        games,
      ),
    });
    const vodRefs: VodRef[] = [
      { matchId: 'm1', opponentTag: null, opponentFighterId: 23, lost: true },
    ];

    const candidates = buildActionCandidates({ claims, vodRefs });
    const vodReview = candidates.find((c) => c.kind === 'vod_review');

    expect(vodReview).toBeDefined();
    expect(vodReview!.claimIds).toEqual([claims[0]!.id]);
    expect(vodReview!.target.matchId).toBe('m1');
  });

  it('a won VodRef (lost: false) never contributes to a vod_review candidate', () => {
    const games = 6;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 5, losses: 1, games },
        games,
      ),
    });
    const vodRefs: VodRef[] = [
      { matchId: 'm1', opponentTag: null, opponentFighterId: 23, lost: false },
    ];

    const candidates = buildActionCandidates({ claims, vodRefs });
    expect(candidates.some((c) => c.kind === 'vod_review')).toBe(false);
  });

  it('multiple matching lost VodRefs leave target.matchId null (axes only, several matches)', () => {
    const games = 6;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 5, losses: 1, games },
        games,
      ),
    });
    const vodRefs: VodRef[] = [
      { matchId: 'm1', opponentTag: null, opponentFighterId: 23, lost: true },
      { matchId: 'm2', opponentTag: null, opponentFighterId: 23, lost: true },
    ];

    const [vodReview] = buildActionCandidates({ claims, vodRefs }).filter(
      (c) => c.kind === 'vod_review',
    );
    expect(vodReview!.target.matchId).toBeNull();
  });

  it('no VodRef behind a claim means no vod_review candidate is ever emitted for it', () => {
    const games = 6;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 5, losses: 1, games },
        games,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    expect(candidates.some((c) => c.kind === 'vod_review')).toBe(false);
  });
});

describe('D-18 drill template table: non-vacuity', () => {
  it('sparse fixture: at least one drill candidate is produced, naming the template that fired', () => {
    const games = PRACTICE_STAGE_MIN_GAMES;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, stageId: 1 };
    const claims = claimsFrom({
      'sr-f8-s1': row(
        'stage_record',
        subject,
        { kind: 'record', wins: 0, losses: games, games },
        games,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    const drills = candidates.filter((c) => c.kind === 'drill');

    expect(drills.length).toBeGreaterThanOrEqual(1);
    expect(drills[0]!.titleKey).toBe('reports.actions.drill.stageHabit');
  });

  it('rich fixture: at least two distinct template ids fire across the set', () => {
    const games = 8;
    const claims = claimsFrom({
      'sr-f8-s1': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 8, stageId: 1 },
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
      'ocu-g23': row(
        'opponent_character_usage',
        { ...NULL_SUBJECT, opponentFighterId: 23 },
        { kind: 'rate', numerator: 6, denominator: 10 },
        10,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    const drillTemplateIds = new Set(
      candidates.filter((c) => c.kind === 'drill').map((c) => c.titleKey),
    );

    expect(drillTemplateIds.size).toBeGreaterThanOrEqual(2);
  });

  it('vod_pattern fires when two vod_annotation claims share a match id', () => {
    const claims = claimsFrom({
      [vodEvidenceId('m1', 30)]: row(
        'vod_annotation',
        NULL_SUBJECT,
        { kind: 'count', count: 30 },
        3,
      ),
      [vodEvidenceId('m1', 45)]: row(
        'vod_annotation',
        NULL_SUBJECT,
        { kind: 'count', count: 45 },
        3,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    const vodPatternDrills = candidates.filter(
      (c) => c.kind === 'drill' && c.titleKey === 'reports.actions.drill.vodPattern',
    );
    expect(vodPatternDrills.length).toBeGreaterThanOrEqual(1);
  });

  it('a lone vod_annotation claim (no shared match id) never fires vod_pattern', () => {
    const claims = claimsFrom({
      [vodEvidenceId('m1', 30)]: row(
        'vod_annotation',
        NULL_SUBJECT,
        { kind: 'count', count: 30 },
        3,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    expect(candidates.some((c) => c.titleKey === 'reports.actions.drill.vodPattern')).toBe(false);
  });

  it('COVERAGE: every row of DRILL_TEMPLATE_TABLE fires in at least one fixture in this file', () => {
    const games = 8;
    const claims = claimsFrom({
      'sr-f8-s1': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 8, stageId: 1 },
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
      'cmr-f8-g23': row(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 },
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
      'ocu-g24': row(
        'opponent_character_usage',
        { ...NULL_SUBJECT, opponentFighterId: 24 },
        { kind: 'rate', numerator: 6, denominator: 10 },
        10,
      ),
      [vodEvidenceId('m1', 30)]: row(
        'vod_annotation',
        NULL_SUBJECT,
        { kind: 'count', count: 30 },
        3,
      ),
      [vodEvidenceId('m1', 45)]: row(
        'vod_annotation',
        NULL_SUBJECT,
        { kind: 'count', count: 45 },
        3,
      ),
    });

    const candidates = buildActionCandidates({ claims, vodRefs: [] });
    const firedTitleKeys = new Set(
      candidates.filter((c) => c.kind === 'drill').map((c) => c.titleKey),
    );

    for (const templateRow of DRILL_TEMPLATE_TABLE) {
      expect(firedTitleKeys.has(templateRow.titleKey)).toBe(true);
    }
  });
});

describe('D-18 non-duplication: a drill can never be a matchup_practice re-emission', () => {
  it('a claim set licensing both kinds yields the matchup_practice candidate and NO drill citing the same claim', () => {
    const games = 8;
    const subject: ClaimSubject = { ...NULL_SUBJECT, myFighterId: 8, opponentFighterId: 23 };
    const claims = claimsFrom({
      'cmr-f8-g23': row(
        'character_matchup_record',
        subject,
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
    });
    const claimId = claims[0]!.id;

    const raw = buildActionCandidates({ claims, vodRefs: [] });
    // Both a matchup_practice candidate and a matchup_punish drill candidate
    // exist in the RAW (pre-suppression) output — the suppression is
    // rankActionCandidates's job.
    expect(raw.some((c) => c.kind === 'matchup_practice')).toBe(true);
    expect(raw.some((c) => c.kind === 'drill')).toBe(true);

    const ranked = rankActionCandidates(raw);
    const rankedDrills = ranked.filter((c) => c.kind === 'drill' && c.claimIds.includes(claimId));
    expect(rankedDrills).toEqual([]);
    expect(ranked.some((c) => c.kind === 'matchup_practice' && c.claimIds.includes(claimId))).toBe(
      true,
    );
  });

  it('a claim set licensing only a drill still yields it after ranking', () => {
    const games = 8;
    const claims = claimsFrom({
      'sr-f8-s1': row(
        'stage_record',
        { ...NULL_SUBJECT, myFighterId: 8, stageId: 1 },
        { kind: 'record', wins: 1, losses: games - 1, games },
        games,
      ),
    });

    const ranked = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));
    expect(ranked.some((c) => c.kind === 'drill')).toBe(true);
  });
});
