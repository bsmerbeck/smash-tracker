import type { Database } from 'firebase-admin/database';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ABSTENTION_FLOOR_GAMES,
  type ActionCandidate,
  type ActionId,
  buildActionCandidates,
  buildClaimSet,
  buildMatchupAdvisorWithGate,
  buildMatchupEvidence,
  buildStageEvidence,
  CLAIM_SCHEMA_VERSION,
  type ClaimSet,
  type ClaimSubject,
  type CohortComposition,
  confidenceTierFor,
  describeCohort,
  EVIDENCE_POLICY_VERSION,
  evidenceIdFor,
  type EvidenceRow,
  type EvidenceSnapshot,
  getStageRecords,
  makeCanonicalizer,
  matchRecordSchema,
  opponentNoteMapSchema,
  orderSnapshotOpponents,
  rankActionCandidates,
  RECENCY_TREATMENT,
  type RecommendedActionKind,
  resolveSubjectDisplayName,
  type ClaimId,
  type ClaimKind,
  type ClaimPredicate,
  type ClaimValue,
  type ConfidenceTier,
  type RecencyTreatment,
  type ReportSurface,
  type SampleMeta,
  selectMyCandidateFighterIds,
  SpriteList,
  type Match,
  type MatchupEvidence,
  type MyCharacterRecordVsOpponent,
  type OpponentNote,
  type ScoutBinding,
  type ScoutReportData,
  type VodRef,
} from '@smash-tracker/shared';
import { canonicalDigest } from '../research/registry/canonical.js';
import { normalizeOpponentTag } from '../startgg/sync.js';
import { claimSelectionSchema, type ClaimSelection } from './claimSelection.js';

// ---------------------------------------------------------------------------
// Binding-aware evidence filtering (Phase 27, RPT-01 grounding)
// ---------------------------------------------------------------------------

/** The three fields `selectOpponentMatches` ever reads off a match record — kept minimal so unit tests can pass bare fixtures instead of full `MatchRecord`s. */
interface OpponentIdentitySignals {
  opponent?: string;
  opponentUserSlug?: string;
  opponentParryUserId?: string;
}

/**
 * Selects which of the caller's own matches count as head-to-head evidence
 * against the scouted opponent. Two modes, selected by whether `binding` is
 * supplied:
 *
 * - No `binding` (every legacy/non-prep report, and the default for any
 *   call site that omits `options`): the UNCHANGED pre-Phase-27 predicate —
 *   a match whose stored start.gg `opponentUserSlug` equals the freshly
 *   scouted player's own `scoutedPlayerUserSlug` is included outright
 *   (this shortcut only ever fires for a start.gg-scouted player —
 *   `scoutedPlayerUserSlug` is naturally absent for a parry.gg scout, so it
 *   always falls through); every other match falls through to
 *   canonicalized-gamerTag matching against `scoutedCanonicalName`.
 * - With a `binding` (a prep report grounded in a confirmed scout binding,
 *   27-CONTEXT.md "Local-match inclusion rule"): the CONFIRMED IDENTITY is
 *   the source of truth, never the tag — see the numbered rules below. This
 *   is also THE CORRECTION (generate.ts:153-169 pre-Phase-27): the old code
 *   handled a start.gg slug shortcut but silently fell back to tags for
 *   parry.gg, never reading `opponentParryUserId` at all.
 */
export function selectOpponentMatches<T extends OpponentIdentitySignals>(params: {
  matches: T[];
  canonicalOpponentName: (name: string | undefined) => string;
  scoutedCanonicalName: string;
  /** The freshly-scouted player's own start.gg profile slug, when known — only ever used on the no-binding path. */
  scoutedPlayerUserSlug?: string;
  binding?: ScoutBinding;
  /** The curated opponent's alias-resolved canonical name this binding belongs to — required for rule 4 below whenever `binding` is supplied. */
  curatedCanonicalName?: string;
}): T[] {
  const {
    matches,
    canonicalOpponentName,
    scoutedCanonicalName,
    scoutedPlayerUserSlug,
    binding,
    curatedCanonicalName,
  } = params;

  return matches.filter((match) => {
    if (binding) {
      // Rule 1 (start.gg identity): a match whose stored slug equals the
      // binding's start.gg slug is the same person, tag or no tag.
      if (
        binding.startggUserSlug &&
        match.opponentUserSlug &&
        match.opponentUserSlug === binding.startggUserSlug
      ) {
        return true;
      }
      // Rule 2 (parry.gg identity — THE CORRECTION): a match whose stored
      // parry user id equals the binding's parry user id is the same
      // person. The pre-Phase-27 code had no branch for this at all.
      if (
        binding.parryUserId &&
        match.opponentParryUserId &&
        match.opponentParryUserId === binding.parryUserId
      ) {
        return true;
      }
      // Rule 3 (different-identity exclusion): a match carrying ANY
      // provider identity that didn't satisfy rule 1 or 2 above belongs to
      // a DIFFERENT person, even when its tag canonicalizes to the curated
      // opponent's name — a shared tag is not a shared person.
      if (match.opponentUserSlug || match.opponentParryUserId) {
        return false;
      }
      // Rule 4 (identity-less manual matches): no provider identity at
      // all — fall back to the alias-resolved canonical name matching the
      // curated opponent this binding belongs to.
      return (
        curatedCanonicalName !== undefined &&
        canonicalOpponentName(match.opponent) === curatedCanonicalName
      );
    }

    // No binding: today's unchanged predicate.
    if (
      match.opponentUserSlug &&
      scoutedPlayerUserSlug &&
      match.opponentUserSlug === scoutedPlayerUserSlug
    ) {
      return true;
    }
    return canonicalOpponentName(match.opponent) === scoutedCanonicalName;
  });
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

const fighterNameById = new Map(SpriteList.map((fighter) => [fighter.id, fighter.name]));

function fighterName(fighterId: number): string {
  return fighterNameById.get(fighterId) ?? `Unknown fighter (${fighterId})`;
}

/** One of the caller's own matches against the scouted player, prepared for the model. */
export interface HeadToHeadMatch {
  result: 'win' | 'loss';
  userCharacter: string;
  opponentCharacter: string;
  stage: string;
  eventName: string | null;
  roundText: string | null;
  stocksLeft: number | null;
  date: string;
}

/**
 * Raw-count aggregate of the caller's results against one of the scouted
 * player's top characters. Phase 36 (D-11, D-14): `sample`/`claimKind` are
 * the engine's claim metadata for this exact match subset (`buildStageEvidence`
 * over the matches vs. this opponent character) so the model reads structured
 * evidence provenance instead of applying a prose sample-size rule of its
 * own — see `SYSTEM_PROMPT` below. `wins`/`losses`/`topStages` stay raw
 * recorded facts, unchanged in meaning.
 */
export interface MatchupAggregate {
  opponentCharacter: string;
  wins: number;
  losses: number;
  topStages: Array<{ stage: string; wins: number; losses: number }>;
  sample: SampleMeta;
  claimKind: ClaimKind;
}

/**
 * Raw-count record for ONE of the user's own characters: overall W/L, plus a
 * per-character breakdown of the user's W/L against each of the scouted
 * player's top characters. Grounds `characterStrategy` recommendations in
 * what the user actually plays, not just what the opponent plays.
 */
export interface CharacterRecord {
  userCharacter: string;
  wins: number;
  losses: number;
  vsOpponentCharacter: Array<{ opponentCharacter: string; wins: number; losses: number }>;
  /** Phase 36 (D-11): the engine's claim metadata for the matches played AS this character. */
  sample: SampleMeta;
}

/**
 * `scout` MUST NOT carry `games` (V9-D's per-game records, added for the
 * web "Full analysis" section) — the payload's own `headToHead`,
 * `vsTopCharacters`, and `matchupAdvisor` already summarize everything a
 * per-game list would add for Claude, so including it here would only
 * inflate token cost for zero grounding benefit. `assembleReportPayload`
 * strips it unconditionally, even when the incoming `scout` has it.
 */
/**
 * Phase 36 (D-05/D-07): one opponent top-character's deterministic
 * matchup-advisor claim — either a ranked recommendation (the pre-Phase-36
 * shape, now carrying `sample`) or, below the abstention floor, an explicit
 * abstention naming how many more countable games would clear it. There is
 * no partial/degraded `ranked` value below the floor — see
 * `EvidenceClaim`'s own doc comment for why.
 */
export type MatchupAdvisorEntry =
  | {
      opponentCharacter: string;
      ranked: Array<{ character: string; score: number; evidence: MatchupEvidence }>;
      sample: SampleMeta;
    }
  | {
      opponentCharacter: string;
      abstained: true;
      gamesNeeded: number;
    };

export interface ReportPayload {
  scout: Omit<ScoutReportData, 'games'>;
  headToHead: HeadToHeadMatch[];
  /**
   * Phase 36 (D-11, D-14): the ONE evidence-policy version/floor/recency
   * treatment/refresh-time every claim in this payload was computed under —
   * a structural fact the model reads instead of a prose sample-size rule
   * (see `SYSTEM_PROMPT` below).
   */
  evidencePolicy: {
    version: number;
    abstentionFloorGames: number;
    recencyTreatment: RecencyTreatment;
    refreshedAt: number;
  };
  /** Phase 36 (D-10, EVID-02): the session-type/provenance composition of the caller's whole match sample this report drew from. */
  cohort: CohortComposition;
  userContext: {
    /** The signed-in user's own primary/secondary character selections (fighter names, not ids). */
    myFighters: { primary: string[]; secondary: string[] };
    /**
     * Records for the union of (the user's primary+secondary fighters) and
     * (their top-5 most-played characters by games in their own match
     * history) — each broken down overall AND vs. the opponent's top-5
     * characters. Raw counts only, same convention as `vsTopCharacters`.
     */
    myCharacterRecords: CharacterRecord[];
    /** W/L vs each of the scouted player's top-5 characters, across ALL the user's matches. */
    vsTopCharacters: MatchupAggregate[];
    /** W/L over the user's most recent 50 matches (any opponent). */
    recentForm: { wins: number; losses: number; sampleSize: number };
    /**
     * V9-B Feature 3: the SAME deterministic matchup-advisor ranking the web
     * ScoutMatchupAdvisorCard shows, one entry per opponent top-5 character
     * — kept lean (opponent's top-5 only, not the full roster) per the
     * feature's payload-size guidance. `characterStrategy` must ground its
     * picks in this, not contradict it without stating why (see SYSTEM_PROMPT).
     * Phase 36 (D-05/D-07): now gated — an opponent character the user has
     * fewer than `evidencePolicy.abstentionFloorGames` countable games
     * against arrives `abstained`, never a confident pick.
     */
    matchupAdvisor: MatchupAdvisorEntry[];
  };
  notes: OpponentNote | null;
  /**
   * Phase 39 (D-01/D-05, RPT-05): the engine's evidence ROWS, keyed by the
   * shared `evidenceIdFor` (one row per `(predicate, subject)`, never per
   * subject alone — review C2-B2). Built from the SAME engine results the
   * fields above are built from; see `buildEvidenceRows` below.
   */
  rows: Readonly<Record<string, EvidenceRow>>;
  /** Phase 39 (D-05): the immutable snapshot over `rows` — content-addressed by `snapshotIdFor` (`./snapshotId.ts`), persisted by plan 39-07. */
  snapshot: EvidenceSnapshot;
  /** Phase 39 (D-01/RPT-05): `buildClaimSet({ rows, surface })` — the engine-authored claims the model may select from. */
  claimSet: ClaimSet;
  /** Phase 39 (RPT-09/D-12): `rankActionCandidates(buildActionCandidates(...))` — the only actions the model may choose from. */
  actionCandidates: readonly ActionCandidate[];
}

/** One claim as the MODEL sees it (Phase 39, D-01): the engine's own fields plus a `displayName` per resolvable subject axis. */
export interface ModelFacingClaim {
  id: ClaimId;
  predicate: ClaimPredicate;
  subject: ClaimSubject;
  /**
   * Review C2-M6: resolved through plan 39-04's `resolveSubjectDisplayName` —
   * the SAME resolver the prose lint licenses entity names from and
   * `projectScoutSelection` stores stage names through — so the names the
   * model is given, the names the lint licenses and the names a record
   * stores are one resolution. Present only for non-null axes.
   */
  displayName: { myFighter?: string; opponentFighter?: string; stage?: string };
  value: ClaimValue;
  kind: ClaimKind;
  tier: ConfidenceTier | null;
  sample: { countableGames: number; totalGames: number };
}

/** One ranked action candidate as the MODEL sees it: its id, kind, and the claim ids that license it. */
export interface ModelFacingActionCandidate {
  id: ActionId;
  kind: RecommendedActionKind;
  claimIds: readonly ClaimId[];
}

/**
 * The user message the model receives (Phase 39, plan 39-06 Task 3). DECISION:
 * the pre-Phase-39 named payload (`scout`, `headToHead`, `userContext`,
 * `notes`) is REPLACED in what is serialized, not kept alongside — it stays
 * on `assembleReportPayload`'s RETURN (the rows are built from it and the
 * existing assembly tests read it) but the model is handed only engine-issued
 * claims and ranked action candidates. Raw history and a free-text note are
 * exactly the material a model would lift an unlicensed number, character or
 * stage from (D-01: the engine authors every specific), and two sources of
 * the same facts is how the weaker one survives (AI-SPEC §4b).
 */
export interface ModelPayload {
  claims: ModelFacingClaim[];
  actionCandidates: ModelFacingActionCandidate[];
}

/** Projects the assembled payload onto the model-facing user message — see `ModelPayload`. */
export function buildModelPayload(payload: ReportPayload): ModelPayload {
  return {
    claims: payload.claimSet.claims.map((claim) => ({
      id: claim.id,
      predicate: claim.predicate,
      subject: claim.subject,
      displayName: {
        ...(claim.subject.myFighterId !== null
          ? { myFighter: resolveSubjectDisplayName('fighter', claim.subject.myFighterId) }
          : {}),
        ...(claim.subject.opponentFighterId !== null
          ? {
              opponentFighter: resolveSubjectDisplayName(
                'fighter',
                claim.subject.opponentFighterId,
              ),
            }
          : {}),
        ...(claim.subject.stageId !== null
          ? { stage: resolveSubjectDisplayName('stage', claim.subject.stageId) }
          : {}),
      },
      value: claim.value,
      kind: claim.claimKind,
      tier: claim.tier,
      sample: {
        countableGames: claim.sample.eligibleDenominator,
        totalGames: claim.sample.rawSampleSize,
      },
    })),
    actionCandidates: payload.actionCandidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      claimIds: candidate.claimIds,
    })),
  };
}

const TOP_CHARACTERS_COUNT = 5;
const TOP_STAGES_PER_MATCHUP = 5;
const RECENT_FORM_SAMPLE_SIZE = 50;
const MY_TOP_CHARACTERS_COUNT = 5;

const KNOWN_FIGHTER_IDS = new Set(SpriteList.map((fighter) => fighter.id));

/** All four subject axes absent — the axis-free subject `recent_form`/`cohort_disclosure` rest on. */
const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

/** A raw win/loss record over a match subset — the ONE `record` value shape every record-valued row uses. */
function recordOf(matches: readonly Match[]): ClaimValue {
  const wins = matches.filter((match) => match.win).length;
  return { kind: 'record', wins, losses: matches.length - wins, games: matches.length };
}

/**
 * The sample for a CHARACTER-axis row (my character, a matchup, head-to-head,
 * recent form, the cohort): the engine's own `buildMatchupEvidence` sample,
 * whose eligible denominator is the known-character games — every
 * character-axis claim's countable games.
 */
function characterAxisSample(matches: Match[], refreshedAt: number): SampleMeta {
  return buildMatchupEvidence({ matches, refreshedAt }).claim.sample;
}

/** The sample for a STAGE-axis row: the engine's own `buildStageEvidence` sample, whose eligible denominator is the known-stage games. */
function stageAxisSample(matches: Match[], refreshedAt: number): SampleMeta {
  return buildStageEvidence({ matches, refreshedAt }).claim.sample;
}

/**
 * Inputs `buildEvidenceRows` reads — every one of them is an engine result
 * or match subset `assembleReportPayload` ALREADY computes for the named
 * payload fields, so the rows and those fields cannot disagree.
 */
interface EvidenceRowInputs {
  scout: ScoutReportData;
  rawMatches: Match[];
  headToHeadMatches: Match[];
  recentMatches: Match[];
  topCharacterIds: number[];
  myFighterIds: number[];
  matchupAdvisorClaims: ReturnType<typeof buildMatchupAdvisorWithGate>;
  refreshedAt: number;
}

/**
 * D-01/RPT-05 (phase 39 plan 06): the evidence ROW map the claim builder,
 * the snapshot and the validator all read. One row per `(predicate,
 * subject)`, keyed by the shared `evidenceIdFor` (review C2-B2) — a
 * `stage_record` and a `stage_pick_rate` over the same stage are TWO rows
 * under two keys. Free text is never a key (review C1-B2): the scouted
 * opponent's tag rides in `subject.opponentTag` as a VALUE, and its key
 * position comes from `orderSnapshotOpponents`, called ONCE here and
 * threaded through every `evidenceIdFor` call (review C2-M10).
 *
 * Families, each from the raw material `CLAIM_PREDICATES`' own comments name:
 * - `stage_record` / `stage_pick_rate` — per opponent top character, per
 *   known stage in the same top-stages cut `vsTopCharacters` uses;
 * - `character_matchup_record` — my character vs. their character;
 * - `my_character_record` — my character overall;
 * - `head_to_head_record` — my matches against this exact player;
 * - `recent_form` — my most recent matches, any opponent (axis-free);
 * - `opponent_character_usage` — ONE ROW PER `scout.characters` ENTRY (the
 *   scouted opponent's public history). Load-bearing (review C3-B1): it is
 *   the only evidence channel a caller with an empty `matches/{uid}` has;
 * - `matchup_advisor_pick` — the deterministic advisor's pick per opponent
 *   top character (or its abstention);
 * - `cohort_disclosure` — the composition count every claim is disclosed
 *   against (axis-free).
 *
 * Empty subsets produce no row (there is nothing to claim); unknown-stage and
 * unknown-character buckets are never a row subject — they stay visible as
 * the sample's `knownFieldCoverage` and the cohort, never as a pickable
 * entity (validator rule R7). `vod_annotation` rows are plan 39-08's
 * (synthesis) and use `vodEvidenceId`, not this function. Every row's
 * `sample.refreshedAt` is the ONE payload-level refresh time.
 */
function buildEvidenceRows(inputs: EvidenceRowInputs): Record<string, EvidenceRow> {
  const {
    scout,
    rawMatches,
    headToHeadMatches,
    recentMatches,
    topCharacterIds,
    myFighterIds,
    matchupAdvisorClaims,
    refreshedAt,
  } = inputs;
  const opponentTag = scout.player.gamerTag;
  const opponentOrder = orderSnapshotOpponents([opponentTag]);
  const rows: Record<string, EvidenceRow> = {};

  function addRow(
    predicate: ClaimPredicate,
    subject: ClaimSubject,
    value: ClaimValue,
    sample: SampleMeta,
  ): void {
    const id = evidenceIdFor({ predicate, subject, opponentOrder });
    rows[id] = { predicate, subject, value, sample: { ...sample, refreshedAt } };
  }

  // stage_record + stage_pick_rate, per opponent top character.
  for (const opponentFighterId of topCharacterIds) {
    const matchesVsCharacter = rawMatches.filter(
      (match) => match.opponent_id === opponentFighterId,
    );
    const knownStageMatches = matchesVsCharacter.filter((match) => (match.map?.id ?? 0) !== 0);
    if (knownStageMatches.length === 0) {
      continue;
    }
    const characterStageSample = stageAxisSample(matchesVsCharacter, refreshedAt);
    const topStageRecords = getStageRecords(knownStageMatches)
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_STAGES_PER_MATCHUP);
    for (const stageRecord of topStageRecords) {
      const subject: ClaimSubject = {
        ...NULL_SUBJECT,
        opponentFighterId,
        stageId: stageRecord.stageId,
      };
      const stageMatches = knownStageMatches.filter(
        (match) => match.map?.id === stageRecord.stageId,
      );
      addRow(
        'stage_record',
        subject,
        recordOf(stageMatches),
        stageAxisSample(stageMatches, refreshedAt),
      );
      addRow(
        'stage_pick_rate',
        subject,
        {
          kind: 'rate',
          numerator: stageRecord.total,
          denominator: characterStageSample.eligibleDenominator,
        },
        characterStageSample,
      );
    }
  }

  // character_matchup_record + my_character_record.
  for (const myFighterId of myFighterIds) {
    const matchesAsCharacter = rawMatches.filter((match) => match.fighter_id === myFighterId);
    if (matchesAsCharacter.length === 0) {
      continue;
    }
    addRow(
      'my_character_record',
      { ...NULL_SUBJECT, myFighterId },
      recordOf(matchesAsCharacter),
      characterAxisSample(matchesAsCharacter, refreshedAt),
    );
    for (const opponentFighterId of topCharacterIds) {
      const matchupMatches = matchesAsCharacter.filter(
        (match) => match.opponent_id === opponentFighterId,
      );
      if (matchupMatches.length === 0) {
        continue;
      }
      addRow(
        'character_matchup_record',
        { ...NULL_SUBJECT, myFighterId, opponentFighterId },
        recordOf(matchupMatches),
        characterAxisSample(matchupMatches, refreshedAt),
      );
    }
  }

  // head_to_head_record — my matches against this exact player.
  if (headToHeadMatches.length > 0) {
    addRow(
      'head_to_head_record',
      { ...NULL_SUBJECT, opponentTag },
      recordOf(headToHeadMatches),
      characterAxisSample(headToHeadMatches, refreshedAt),
    );
  }

  // recent_form — axis-free.
  if (recentMatches.length > 0) {
    addRow(
      'recent_form',
      NULL_SUBJECT,
      recordOf(recentMatches),
      characterAxisSample(recentMatches, refreshedAt),
    );
  }

  // opponent_character_usage — one row per scout.characters entry (C3-B1).
  // A usage SHARE rests on the opponent's whole countable public sample: the
  // rate's denominator IS the sample's eligible denominator (the opponent's
  // games on a known character), which is what validator rule R7 requires of
  // every rate claim (`packages/shared/src/evidence/validateReport.ts`), and
  // that countable total drives the tier and the abstention decision exactly
  // as every other family's countable games do. Unmapped-character games
  // (the scout's fighterId-0 bucket) stay out of the denominator and show up
  // as `knownFieldCoverage` below 1, never as a claimable entity.
  const knownCharacters = scout.characters.filter(
    (character) => KNOWN_FIGHTER_IDS.has(character.fighterId) && character.games > 0,
  );
  const knownCharacterGames = knownCharacters.reduce((sum, character) => sum + character.games, 0);
  if (knownCharacterGames > 0) {
    const usageSample: SampleMeta = {
      rawSampleSize: scout.sampledGames,
      eligibleDenominator: knownCharacterGames,
      knownFieldCoverage: scout.sampledGames > 0 ? knownCharacterGames / scout.sampledGames : 0,
      dateRange: null,
      refreshedAt,
      evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
      recencyTreatment: RECENCY_TREATMENT,
      confidenceTier: confidenceTierFor(knownCharacterGames),
    };
    for (const character of knownCharacters) {
      addRow(
        'opponent_character_usage',
        { ...NULL_SUBJECT, opponentFighterId: character.fighterId, opponentTag },
        { kind: 'rate', numerator: character.games, denominator: knownCharacterGames },
        usageSample,
      );
    }
  }

  // matchup_advisor_pick — zipped against topCharacterIds by index, the
  // same way the named `matchupAdvisor` field is.
  topCharacterIds.forEach((opponentFighterId, index) => {
    const claim = matchupAdvisorClaims[index];
    if (!claim) {
      return;
    }
    const subject: ClaimSubject = { ...NULL_SUBJECT, opponentFighterId };
    if (claim.kind === 'abstained') {
      addRow(
        'matchup_advisor_pick',
        subject,
        { kind: 'abstained', gamesNeeded: claim.gamesNeeded },
        claim.sample,
      );
      return;
    }
    const topPick = claim.value.ranked[0];
    if (!topPick) {
      return;
    }
    // The picked character rides on the SUBJECT (as `myFighterId`) as well
    // as in the value: the prose lint licenses entity names from a claim's
    // subject axes only, so this is what lets the model name the pick it is
    // explaining — and what gives it a `displayName` to name it by.
    addRow(
      'matchup_advisor_pick',
      { ...subject, myFighterId: topPick.fighterId },
      { kind: 'entity', entityKind: 'fighter', entityId: String(topPick.fighterId) },
      claim.sample,
    );
  });

  // cohort_disclosure — axis-free.
  if (rawMatches.length > 0) {
    addRow(
      'cohort_disclosure',
      NULL_SUBJECT,
      { kind: 'count', count: rawMatches.length },
      characterAxisSample(rawMatches, refreshedAt),
    );
  }

  return rows;
}

/**
 * Assembles the JSON payload handed to Claude, built from two deliberately
 * SEPARATED evidence layers (27-CONTEXT.md "Model payload — two explicitly
 * separated evidence layers"):
 *
 * - LIVE PUBLIC evidence: `scout`, the freshly-fetched `ScoutReportData` for
 *   the confirmed stable provider identity (resolved by the caller before
 *   this function is ever called).
 * - PRIVATE PLAYER evidence: the caller's own stored head-to-head matches,
 *   known characters, and saved note for the curated canonical opponent —
 *   selected via `selectOpponentMatches` above, grounded in `options.binding`
 *   when supplied (a prep report) or the unchanged tag-based predicate
 *   otherwise (every legacy report).
 *
 * The model payload STRUCTURE itself (`ReportPayload`) is otherwise
 * unchanged by `options` — only which matches populate `headToHead` and feed
 * the aggregates below can differ.
 */
export async function assembleReportPayload(
  uid: string,
  scout: ScoutReportData,
  database: Database,
  options?: {
    binding?: ScoutBinding;
    curatedCanonicalName?: string;
    /** Phase 39: the surface the claim set is built for. `buildClaimSet` never branches on it (RPT-05); it defaults to `'scout'`. */
    surface?: ReportSurface;
  },
): Promise<ReportPayload> {
  const [
    matchesSnapshot,
    aliasSnapshot,
    noteSnapshot,
    primaryFightersSnapshot,
    secondaryFightersSnapshot,
  ] = await Promise.all([
    database.ref(`matches/${uid}`).get(),
    database.ref(`opponentAliases/${uid}`).get(),
    database.ref(`opponentNotes/${uid}`).get(),
    database.ref(`primaryFighters/${uid}`).get(),
    database.ref(`secondaryFighters/${uid}`).get(),
  ]);

  // Phase 36 (D-11): a single refresh timestamp for every claim this payload
  // assembles, mirroring the web tier's page-level `useState(() =>
  // Date.now())` pattern (plan 36-02) — every sibling claim in this one
  // report reports the same provenance timestamp.
  const refreshedAt = Date.now();

  const aliasMap = aliasSnapshot.exists()
    ? (aliasSnapshot.val() as Record<string, string>)
    : ({} as Record<string, string>);

  const matchEntries = matchesSnapshot.exists()
    ? Object.entries(matchesSnapshot.val() as Record<string, unknown>)
    : [];
  const rawMatches = matchEntries.map(([, value]) => matchRecordSchema.parse(value)) as Array<
    ReturnType<typeof matchRecordSchema.parse> & { time: number }
  >;

  // `getStageRecords`/`buildStageEvidence`/`describeCohort` are typed over
  // `Match[]` (the API-response shape with an `id`). None of them reads `id`;
  // Phase 39 does — a `VodRef` (below) names the REAL match, so `id` is the
  // RTDB push key the row is stored under (same entry order as `rawMatches`).
  const rawMatchesWithId: Match[] = rawMatches.map((match, index) => ({
    ...match,
    id: matchEntries[index]![0],
  }));

  // Phase 36 (EVID-12): the alias hop has exactly one implementation now —
  // `makeCanonicalizer` from the engine, the same idempotent
  // normalize-then-hop `opponentEvidence.ts` uses. `normalizeOpponentTag`
  // (imported above from `../startgg/sync.js`, the canonical sync-time
  // definition) is still needed directly for `scoutedCanonicalName` below,
  // which normalizes the freshly-scouted player's OWN tag — never looked up
  // in this caller's `aliasMap`, which only covers their own recorded
  // opponents.
  const canonicalOpponentName = makeCanonicalizer(aliasMap);

  const scoutedCanonicalName = normalizeOpponentTag(scout.player.gamerTag);

  // H2H matching: delegates to `selectOpponentMatches` above. With no
  // `options.binding` (every legacy report), this is byte-identical to the
  // pre-Phase-27 predicate — the `opponentUserSlug` shortcut only ever
  // applies to start.gg-scouted players; for a parry.gg-scouted player
  // (V9-B Feature 4), `scout.player.userSlug` is simply absent, so it
  // naturally falls through to canonicalized-gamerTag matching.
  const matchesVsScoutedPlayer = selectOpponentMatches({
    matches: rawMatchesWithId,
    canonicalOpponentName,
    scoutedCanonicalName,
    scoutedPlayerUserSlug: scout.player.userSlug,
    binding: options?.binding,
    curatedCanonicalName: options?.curatedCanonicalName,
  });

  const headToHead: HeadToHeadMatch[] = [...matchesVsScoutedPlayer]
    .sort((a, b) => b.time - a.time)
    .map((match) => ({
      result: match.win ? 'win' : 'loss',
      userCharacter: fighterName(match.fighter_id),
      opponentCharacter: fighterName(match.opponent_id),
      stage: match.map ? match.map.name : 'Unknown stage',
      eventName: match.eventName ?? null,
      roundText: match.roundText ?? null,
      stocksLeft: match.stocksLeft ?? null,
      date: new Date(match.time).toISOString(),
    }));

  // vsTopCharacters: for each of the scouted player's top-5 characters (by
  // games played), the user's W/L across ALL their own matches where THEIR
  // opponent's in-game character (opponent_id) matches that fighter, plus a
  // per-stage breakdown within those matchups (top stages by games played).
  const topCharacterIds = scout.characters.slice(0, TOP_CHARACTERS_COUNT).map((c) => c.fighterId);

  const vsTopCharacters: MatchupAggregate[] = topCharacterIds.map((fighterId) => {
    const matchesVsCharacter = rawMatchesWithId.filter((match) => match.opponent_id === fighterId);
    const wins = matchesVsCharacter.filter((match) => match.win).length;
    const losses = matchesVsCharacter.length - wins;

    // R1-HIGH-3: the stage NAME is the whole risk here. `getStageRecords`
    // keys on the numeric `map.id` and carries no name, so the name is
    // re-derived from the FIRST-SEEN `match.map.name` for that id — never
    // from `stagesById` (which would emit a different string than the one
    // actually stored on the row for any legacy/renamed stage). One
    // behavioural consequence: two rows whose `map.id` is equal but whose
    // stored `map.name` differs now collapse into a single row carrying the
    // first-seen name — asserted in generate.test.ts, not merely assumed.
    const stageNameById = new Map<number, string>();
    for (const match of matchesVsCharacter) {
      const id = match.map?.id ?? 0;
      if (id !== 0 && match.map && !stageNameById.has(id)) {
        stageNameById.set(id, match.map.name);
      }
    }

    // Phase 36 (D-09, EVID-11): unknown-stage games are excluded from the
    // count-sorted `topStages` ranking below — never silently mixed in — and
    // reported as their own forced-last entry from the engine's explicit
    // `unknown` bucket instead (see `stageEvidence` below), so the model sees
    // excluded games rather than a silently shorter list.
    const topStages = getStageRecords(
      matchesVsCharacter.filter((match) => (match.map?.id ?? 0) !== 0),
    )
      .sort((a, b) => b.total - a.total)
      .slice(0, TOP_STAGES_PER_MATCHUP)
      .map((record) => ({
        stage: stageNameById.get(record.stageId) ?? 'Unknown stage',
        wins: record.wins,
        losses: record.losses,
      }));

    // Phase 36 (D-11, D-14): the shared engine's stage-evidence claim over
    // this exact match subset (vs. one opponent top character) — supplies
    // this row's `sample`/`claimKind` AND the explicit unknown-stage bucket
    // appended below.
    const stageEvidence = buildStageEvidence({ matches: matchesVsCharacter, refreshedAt });
    if (stageEvidence.unknown) {
      topStages.push({
        stage: 'Unknown stage',
        wins: stageEvidence.unknown.wins,
        losses: stageEvidence.unknown.losses,
      });
    }

    return {
      opponentCharacter: fighterName(fighterId),
      wins,
      losses,
      topStages,
      sample: stageEvidence.claim.sample,
      claimKind: stageEvidence.claim.claimType,
    };
  });

  const recentMatches = [...rawMatchesWithId]
    .sort((a, b) => b.time - a.time)
    .slice(0, RECENT_FORM_SAMPLE_SIZE);
  const recentWins = recentMatches.filter((match) => match.win).length;

  const notesMap = noteSnapshot.exists()
    ? opponentNoteMapSchema.parse(noteSnapshot.val())
    : ({} as Record<string, OpponentNote>);
  const notes = notesMap[scoutedCanonicalName] ?? null;

  // myFighters: the user's own primary/secondary character selections,
  // mapped from sprite ids to names for the model.
  const primaryFighterIds = primaryFightersSnapshot.exists()
    ? (primaryFightersSnapshot.val() as number[])
    : [];
  const secondaryFighterIds = secondaryFightersSnapshot.exists()
    ? (secondaryFightersSnapshot.val() as number[])
    : [];

  const myFighters = {
    primary: primaryFighterIds.map((id) => fighterName(id)),
    secondary: secondaryFighterIds.map((id) => fighterName(id)),
  };

  // myCharacterRecords: union of (the user's primary+secondary fighters) and
  // (the user's own top-5 characters by games played in their own match
  // history), each broken down overall AND vs. the opponent's top-5
  // characters. This is what grounds characterStrategy — the model must only
  // recommend characters the user demonstrably plays. `selectMyCandidateFighterIds`
  // is the SAME shared helper `ScoutMatchupAdvisorCard` uses client-side, so
  // both the AI report's grounding and the web card's advisor rank the exact
  // same candidate set.
  const myFighterIds = selectMyCandidateFighterIds(
    rawMatches.map((match) => match.fighter_id),
    primaryFighterIds,
    secondaryFighterIds,
    MY_TOP_CHARACTERS_COUNT,
  );

  const myCharacterRecords: CharacterRecord[] = myFighterIds.map((fighterId) => {
    const matchesAsThisCharacter = rawMatchesWithId.filter(
      (match) => match.fighter_id === fighterId,
    );
    const wins = matchesAsThisCharacter.filter((match) => match.win).length;
    const losses = matchesAsThisCharacter.length - wins;

    const vsOpponentCharacter = topCharacterIds.map((opponentFighterId) => {
      const matchesVsOpponentCharacter = matchesAsThisCharacter.filter(
        (match) => match.opponent_id === opponentFighterId,
      );
      const vsWins = matchesVsOpponentCharacter.filter((match) => match.win).length;
      return {
        opponentCharacter: fighterName(opponentFighterId),
        wins: vsWins,
        losses: matchesVsOpponentCharacter.length - vsWins,
      };
    });

    // Phase 36 (D-11, D-14): the same engine call used for `vsTopCharacters`
    // above, over this character's OWN matches — supplies this row's
    // `sample` claim metadata.
    const sample = buildStageEvidence({ matches: matchesAsThisCharacter, refreshedAt }).claim
      .sample;

    return {
      userCharacter: fighterName(fighterId),
      wins,
      losses,
      vsOpponentCharacter,
      sample,
    };
  });

  // matchupAdvisor (V9-B Feature 3): the SAME deterministic ranking the web
  // ScoutMatchupAdvisorCard shows, computed server-side from the shared
  // `matchupAdvisor.ts` module — zero added Claude cost, and guarantees the
  // model's characterStrategy can never contradict what the UI already told
  // the user without a stated reason (see the updated SYSTEM_PROMPT below).
  // Raw per-my-character W/L vs. each opponent top character, built from the
  // SAME `rawMatches` used for `myCharacterRecords` above (not re-fetched).
  const recordsByOpponentFighterId = new Map<number, MyCharacterRecordVsOpponent[]>(
    topCharacterIds.map((opponentFighterId) => [
      opponentFighterId,
      myFighterIds.map((fighterId) => {
        const matchesAsThisVsOpponent = rawMatches.filter(
          (match) => match.fighter_id === fighterId && match.opponent_id === opponentFighterId,
        );
        const wins = matchesAsThisVsOpponent.filter((match) => match.win).length;
        return { fighterId, wins, losses: matchesAsThisVsOpponent.length - wins };
      }),
    ]),
  );
  // Phase 36 (D-05/D-07): the character advisor's first hard abstention
  // floor, server-side — `buildMatchupAdvisorWithGate` returns one claim per
  // `topCharacterIds` entry, in the SAME order, so it can be zipped back
  // against the original opponent fighter ids by index (an abstained claim
  // carries no `value`, hence no `opponentFighterId` of its own).
  const matchupAdvisorClaims = buildMatchupAdvisorWithGate(
    topCharacterIds,
    myFighterIds,
    recordsByOpponentFighterId,
  );
  const matchupAdvisor: MatchupAdvisorEntry[] = topCharacterIds.map((opponentFighterId, index) => {
    const claim = matchupAdvisorClaims[index]!;
    if (claim.kind === 'abstained') {
      return {
        opponentCharacter: fighterName(opponentFighterId),
        abstained: true,
        gamesNeeded: claim.gamesNeeded,
      };
    }
    return {
      opponentCharacter: fighterName(opponentFighterId),
      ranked: claim.value.ranked.map((pick) => ({
        character: fighterName(pick.fighterId),
        score: pick.score,
        evidence: pick.evidence,
      })),
      sample: claim.sample,
    };
  });

  // Phase 39 (D-01/D-05): the evidence rows, the immutable snapshot over them
  // and the engine-authored claim set — built from the SAME engine results
  // and match subsets as every named field above (see `buildEvidenceRows`).
  const rows = buildEvidenceRows({
    scout,
    rawMatches: rawMatchesWithId,
    headToHeadMatches: matchesVsScoutedPlayer,
    recentMatches,
    topCharacterIds,
    myFighterIds,
    matchupAdvisorClaims,
    refreshedAt,
  });
  // The match-id digest: count plus the canonical hash of the input match
  // ids (the RTDB push keys under `matches/{uid}`), sorted so the digest is
  // independent of read order. Reuses the ONE canonicalizer (C1-B2).
  const matchIds = matchesSnapshot.exists()
    ? Object.keys(matchesSnapshot.val() as Record<string, unknown>).sort()
    : [];
  const cohort = describeCohort(rawMatchesWithId);
  const snapshot: EvidenceSnapshot = {
    policyVersion: EVIDENCE_POLICY_VERSION,
    claimSchemaVersion: CLAIM_SCHEMA_VERSION,
    refreshedAt,
    cohort,
    rows,
    matchIdDigest: { count: matchIds.length, hash: canonicalDigest(matchIds) },
  };
  const claimSet = buildClaimSet({ rows, surface: options?.surface ?? 'scout' });
  // RPT-09/D-12: the ranked action candidates. VOD refs are ADAPTED from the
  // EXISTING `selectOpponentMatches` result (the already-corrected shipped
  // opponent predicate) — a lost head-to-head match carrying at least one VOD
  // timestamp — never from a second, hand-rolled opponent predicate.
  const vodRefs: VodRef[] = matchesVsScoutedPlayer
    .filter((match) => !match.win && (match.vodTimestamps?.length ?? 0) > 0)
    .map((match) => ({
      matchId: match.id,
      opponentTag: scout.player.gamerTag,
      opponentFighterId: match.opponent_id,
      lost: true,
    }));
  const actionCandidates = rankActionCandidates(
    buildActionCandidates({ claims: claimSet.claims, vodRefs }),
  );

  // Strip `games` (V9-D) before handing the scout data to Claude — see the
  // doc comment on `ReportPayload.scout`.
  const scoutForPayload: Omit<ScoutReportData, 'games'> = {
    player: scout.player,
    sampledSets: scout.sampledSets,
    sampledGames: scout.sampledGames,
    characters: scout.characters,
    stages: scout.stages,
    recentEvents: scout.recentEvents,
    commonOpponents: scout.commonOpponents,
  };

  return {
    scout: scoutForPayload,
    headToHead,
    evidencePolicy: {
      version: EVIDENCE_POLICY_VERSION,
      abstentionFloorGames: ABSTENTION_FLOOR_GAMES,
      recencyTreatment: RECENCY_TREATMENT,
      refreshedAt,
    },
    cohort,
    userContext: {
      myFighters,
      myCharacterRecords,
      vsTopCharacters,
      recentForm: {
        wins: recentWins,
        losses: recentMatches.length - recentWins,
        sampleSize: recentMatches.length,
      },
      matchupAdvisor,
    },
    notes,
    rows,
    snapshot,
    claimSet,
    actionCandidates,
  };
}

// ---------------------------------------------------------------------------
// Claude call
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for the Anthropic client — just the one
 * method this module calls. Lets tests pass a plain stub with a mocked
 * `messages.parse` instead of constructing a real `Anthropic` instance.
 */
export interface AnthropicLikeClient {
  messages: {
    parse: (params: {
      model: string;
      max_tokens: number;
      thinking: { type: 'adaptive' };
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
      output_config: {
        format: ReturnType<typeof zodOutputFormat<typeof claimSelectionSchema>>;
      };
    }) => Promise<{
      stop_reason: string | null;
      parsed_output: ClaimSelection | null;
    }>;
  };
}

const REPORT_MODEL = 'claude-opus-4-8';
const REPORT_MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are a competitive Super Smash Bros. Ultimate coach writing a pre-bracket scouting brief for the user about one opponent.

The user message is JSON with two lists. "claims" are findings the app has already computed from the user's own match history and the opponent's public results: each has an id, what it is about (with the display names of its characters and stage), and the recorded value. A claim whose value is "abstained" is a gap in the evidence, not a finding. "actionCandidates" are practice actions the app has already ranked; each lists the claim ids that justify it.

Your job is to choose which claims matter most against this opponent and explain how they connect.
- Fill the three sections (overview, gameplan, watchFor). For each, list the ids of the claims it rests on, most important first, and write one or two short sentences of connective prose explaining how those claims fit together and what the user should do about them.
- Fill up to three action slots, in priority order, with actions from actionCandidates, each naming the claim it rests on. Leave a slot null when no candidate fits.
- Use only claim ids and action ids that appear in the input.
- Do not compute, count, rank or estimate anything. Do not introduce any number, character, stage, player or event that is not in a claim you listed in that same section, and refer to characters and stages only by the display names those claims give. The app shows each claim's own values beside it, so the prose does not need to repeat them.`;

/** Thrown for a Claude response that didn't produce a usable report. */
export class ReportGenerationError extends Error {
  constructor(readonly reason: 'refusal' | 'truncated' | 'unparseable') {
    super(
      reason === 'refusal'
        ? 'Claude declined to generate a report for this request'
        : reason === 'truncated'
          ? 'Claude report generation was truncated before completing'
          : 'Claude returned a response that could not be parsed into a report',
    );
    this.name = 'ReportGenerationError';
  }
}

/**
 * Calls Claude to SELECT claims from the assembled payload (Phase 39,
 * D-01): the output is a `ClaimSelection` over the fixed claim-id
 * vocabulary, never a free-prose report. Uses `client.messages.parse` with
 * `output_config.format` built from `zodOutputFormat` (validated against the
 * installed `@anthropic-ai/sdk` version to accept zod v4 schemas directly).
 * The guard ORDER below — refusal, then truncation, then a null parse — is
 * load-bearing and unchanged.
 */
export async function generateScoutReport(
  client: AnthropicLikeClient,
  payload: ReportPayload,
): Promise<ClaimSelection> {
  const response = await client.messages.parse({
    model: REPORT_MODEL,
    max_tokens: REPORT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(buildModelPayload(payload)) }],
    output_config: { format: zodOutputFormat(claimSelectionSchema) },
  });

  if (response.stop_reason === 'refusal') {
    throw new ReportGenerationError('refusal');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ReportGenerationError('truncated');
  }
  if (response.parsed_output == null) {
    throw new ReportGenerationError('unparseable');
  }

  return response.parsed_output;
}

export { Anthropic };
