import {
  buildActionCandidates,
  buildClaimSet,
  buildMatchupAdvisorWithGate,
  buildMatchupEvidence,
  buildOpponentCrossTab,
  buildStageEvidence,
  evidenceIdFor,
  getStageRecords,
  MAX_RECOMMENDED_ACTIONS,
  orderSnapshotOpponents,
  rankActionCandidates,
  resolveOpponentIdentities,
  selectMyCandidateFighterIds,
  selectTopActions,
  SpriteList,
  type ActionCandidate,
  type ClaimAtom,
  type ClaimPredicate,
  type ClaimSubject,
  type ClaimValue,
  type EvidenceRow,
  type Match,
  type MyCharacterRecordVsOpponent,
  type SampleMeta,
  type VodRef,
} from '@smash-tracker/shared';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12, review C1-H8): the FREE prep brief's
 * recommended-action producer. The free brief (`prepBriefSchema`, built by
 * `apps/api/src/prep/`) carries no claims — that module stays free of any
 * reports dependency — so the brief page derives them here, from data it
 * already holds, through the SAME shared engine the paid path runs:
 * `buildClaimSet` over evidence rows, then `buildActionCandidates` →
 * `rankActionCandidates` → `selectTopActions`. No route, no fetch, no model
 * call; no number is authored here — every value is a win/loss count, a
 * games count or an engine result over the caller's own matches.
 *
 * Rows mirror the API's `buildEvidenceRows` (`apps/api/src/reports/generate.ts`)
 * family by family. The one difference is where the opponent's characters
 * come from: the paid path reads the opponent's PUBLIC history (a live
 * scout); the free brief has only the caller's own games, so the opponent's
 * characters are the ones they played against the caller, read off the
 * shared `buildOpponentCrossTab`.
 *
 * Identity: every likely opponent is resolved through the shared
 * `resolveOpponentIdentities` (provider id first, then the alias chain) —
 * never a raw tag comparison — so a game recorded under an alias still
 * counts. Keys: every row is keyed by the shared `evidenceIdFor`, with the
 * opponent ordering from the shared `orderSnapshotOpponents` (reviews
 * C2-B2 / C2-M10), so this producer and the API cannot key or order rows
 * two different ways.
 *
 * PURE: no React, no query, no uid, no subject branch.
 */

/** How many of each likely opponent's characters (by games against the caller) get matchup rows — the API's `TOP_CHARACTERS_COUNT`. */
const TOP_CHARACTERS_PER_OPPONENT = 5;
/** Top stages per opponent character — the API's `TOP_STAGES_PER_MATCHUP`. */
const TOP_STAGES_PER_MATCHUP = 5;
/** The caller's most-recent-games window for `recent_form` — the API's `RECENT_FORM_SAMPLE_SIZE`. */
const RECENT_FORM_SAMPLE_SIZE = 50;
/** How many of the caller's own characters are candidates — the API's `MY_TOP_CHARACTERS_COUNT`. */
const MY_TOP_CHARACTERS_COUNT = 5;

const KNOWN_FIGHTER_IDS = new Set(SpriteList.map((fighter) => fighter.id));

const NULL_SUBJECT: ClaimSubject = {
  myFighterId: null,
  opponentFighterId: null,
  stageId: null,
  opponentTag: null,
};

export interface PrepBriefActionsInput {
  /** The caller's own matches, all-time and all-source, as stored (alias resolution happens here, through the shared identity resolver). */
  matches: readonly Match[];
  /** The caller's opponent alias map. */
  aliasMap: Readonly<Record<string, string>>;
  /** The brief's likely-opponent names (the keys of `brief.likelyOpponents`). */
  likelyOpponentTags: readonly string[];
  /** The caller's declared fighters (`useFighters()`), which widen the candidate set beyond the characters they played most. */
  myFighters: { primary: readonly number[]; secondary: readonly number[] };
  /** One provenance timestamp for every sample in this derivation (the page's mount time). */
  refreshedAt: number;
}

export interface PrepBriefActions {
  claims: readonly ClaimAtom[];
  actions: readonly ActionCandidate[];
}

function recordOf(matches: readonly Match[]): ClaimValue {
  const wins = matches.filter((match) => match.win).length;
  return { kind: 'record', wins, losses: matches.length - wins, games: matches.length };
}

function characterAxisSample(matches: readonly Match[], refreshedAt: number): SampleMeta {
  return buildMatchupEvidence({ matches: [...matches], refreshedAt }).claim.sample;
}

function stageAxisSample(matches: readonly Match[], refreshedAt: number): SampleMeta {
  return buildStageEvidence({ matches: [...matches], refreshedAt }).claim.sample;
}

/** One likely opponent's resolved games against the caller and their characters, most-played first. */
interface OpponentEvidence {
  tag: string;
  versus: Match[];
  /** Games per opponent character, from the cross-tab (known characters on both sides only). */
  characterGames: Map<number, number>;
}

function characterGamesFromCrossTab(
  matches: Match[],
  aliasMap: Record<string, string>,
  tag: string,
  refreshedAt: number,
): Map<number, number> {
  const crossTab = buildOpponentCrossTab({ matches, aliasMap, opponentTag: tag, refreshedAt });
  const games = new Map<number, number>();
  for (const row of crossTab.rows) {
    if (!KNOWN_FIGHTER_IDS.has(row.theirFighterId)) {
      continue;
    }
    games.set(row.theirFighterId, (games.get(row.theirFighterId) ?? 0) + row.total);
  }
  return games;
}

/** Characters by games descending, fighter id ascending as the tiebreak. */
function mostPlayed(characterGames: Map<number, number>): number[] {
  return [...characterGames.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] - b[0]))
    .map(([fighterId]) => fighterId);
}

/**
 * Derives the free brief's claims and its top recommended actions (at most
 * `MAX_RECOMMENDED_ACTIONS`). Deterministic: the same input always yields
 * deeply-equal output. A caller with no matches against any likely opponent
 * gets an empty action list.
 */
export function buildPrepBriefActions(input: PrepBriefActionsInput): PrepBriefActions {
  const { likelyOpponentTags, myFighters, refreshedAt } = input;
  const matches = [...input.matches];
  const aliasMap = { ...input.aliasMap };
  const resolve = resolveOpponentIdentities(matches, aliasMap);

  const opponentTags = orderSnapshotOpponents(
    likelyOpponentTags
      .map((tag) => resolve({ opponent: tag }))
      .filter((tag) => tag.length > 0 && tag !== 'unknown'),
  );

  const opponents: OpponentEvidence[] = opponentTags.map((tag) => ({
    tag,
    versus: matches.filter((match) => resolve(match) === tag),
    characterGames: characterGamesFromCrossTab(matches, aliasMap, tag, refreshedAt),
  }));

  const opponentCharacterIds: number[] = [];
  for (const opponent of opponents) {
    for (const fighterId of mostPlayed(opponent.characterGames).slice(
      0,
      TOP_CHARACTERS_PER_OPPONENT,
    )) {
      if (!opponentCharacterIds.includes(fighterId)) {
        opponentCharacterIds.push(fighterId);
      }
    }
  }

  const myFighterIds = selectMyCandidateFighterIds(
    matches.map((match) => match.fighter_id),
    [...myFighters.primary],
    [...myFighters.secondary],
    MY_TOP_CHARACTERS_COUNT,
  );

  const rows: Record<string, EvidenceRow> = {};
  function addRow(
    predicate: ClaimPredicate,
    subject: ClaimSubject,
    value: ClaimValue,
    sample: SampleMeta,
  ): void {
    const id = evidenceIdFor({ predicate, subject, opponentOrder: opponentTags });
    rows[id] = { predicate, subject, value, sample: { ...sample, refreshedAt } };
  }

  // stage_record + stage_pick_rate, per opponent character (the caller's
  // games against that character, on a known stage).
  for (const opponentFighterId of opponentCharacterIds) {
    const matchesVsCharacter = matches.filter((match) => match.opponent_id === opponentFighterId);
    const knownStageMatches = matchesVsCharacter.filter((match) => (match.map?.id ?? 0) !== 0);
    if (knownStageMatches.length === 0) {
      continue;
    }
    const characterStageSample = stageAxisSample(matchesVsCharacter, refreshedAt);
    const topStageRecords = getStageRecords(knownStageMatches)
      .sort((a, b) => (b.total !== a.total ? b.total - a.total : a.stageId - b.stageId))
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

  // my_character_record + character_matchup_record.
  for (const myFighterId of myFighterIds) {
    const matchesAsCharacter = matches.filter((match) => match.fighter_id === myFighterId);
    if (matchesAsCharacter.length === 0) {
      continue;
    }
    addRow(
      'my_character_record',
      { ...NULL_SUBJECT, myFighterId },
      recordOf(matchesAsCharacter),
      characterAxisSample(matchesAsCharacter, refreshedAt),
    );
    for (const opponentFighterId of opponentCharacterIds) {
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

  // head_to_head_record + opponent_character_usage, per likely opponent.
  for (const opponent of opponents) {
    if (opponent.versus.length === 0) {
      continue;
    }
    addRow(
      'head_to_head_record',
      { ...NULL_SUBJECT, opponentTag: opponent.tag },
      recordOf(opponent.versus),
      characterAxisSample(opponent.versus, refreshedAt),
    );
    const usageSample = characterAxisSample(opponent.versus, refreshedAt);
    if (usageSample.eligibleDenominator === 0) {
      continue;
    }
    for (const [opponentFighterId, games] of opponent.characterGames) {
      addRow(
        'opponent_character_usage',
        { ...NULL_SUBJECT, opponentFighterId, opponentTag: opponent.tag },
        { kind: 'rate', numerator: games, denominator: usageSample.eligibleDenominator },
        usageSample,
      );
    }
  }

  // recent_form — axis-free.
  const recentMatches = [...matches]
    .sort((a, b) => (b.time !== a.time ? b.time - a.time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, RECENT_FORM_SAMPLE_SIZE);
  if (recentMatches.length > 0) {
    addRow(
      'recent_form',
      NULL_SUBJECT,
      recordOf(recentMatches),
      characterAxisSample(recentMatches, refreshedAt),
    );
  }

  // matchup_advisor_pick — the same gated advisor the scout card and the API
  // run, zipped against the opponent characters by index.
  const recordsByOpponentFighterId = new Map<number, MyCharacterRecordVsOpponent[]>(
    opponentCharacterIds.map((opponentFighterId) => [
      opponentFighterId,
      myFighterIds.map((fighterId) => {
        const games = matches.filter(
          (match) => match.fighter_id === fighterId && match.opponent_id === opponentFighterId,
        );
        const wins = games.filter((match) => match.win).length;
        return { fighterId, wins, losses: games.length - wins };
      }),
    ]),
  );
  const advisorClaims = buildMatchupAdvisorWithGate(
    opponentCharacterIds,
    myFighterIds,
    recordsByOpponentFighterId,
  );
  opponentCharacterIds.forEach((opponentFighterId, index) => {
    const claim = advisorClaims[index];
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
    addRow(
      'matchup_advisor_pick',
      { ...subject, myFighterId: topPick.fighterId },
      { kind: 'entity', entityKind: 'fighter', entityId: String(topPick.fighterId) },
      claim.sample,
    );
  });

  // cohort_disclosure — axis-free, over every game this derivation read.
  if (matches.length > 0) {
    addRow(
      'cohort_disclosure',
      NULL_SUBJECT,
      { kind: 'count', count: matches.length },
      characterAxisSample(matches, refreshedAt),
    );
  }

  const claimSet = buildClaimSet({ rows, surface: 'prep_report' });

  // VOD refs: a LOST game against a likely opponent that carries at least
  // one VOD timestamp, from the same resolved game sets as the rows.
  const vodRefs: VodRef[] = opponents.flatMap((opponent) =>
    opponent.versus
      .filter((match) => !match.win && (match.vodTimestamps?.length ?? 0) > 0)
      .map((match) => ({
        matchId: match.id,
        opponentTag: opponent.tag,
        opponentFighterId: match.opponent_id,
        lost: true,
      })),
  );

  const actions = selectTopActions(
    rankActionCandidates(buildActionCandidates({ claims: claimSet.claims, vodRefs })),
    MAX_RECOMMENDED_ACTIONS,
  );

  return { claims: claimSet.claims, actions };
}
