import type { Database } from 'firebase-admin/database';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  buildMatchupAdvisor,
  generatedScoutReportSchema,
  matchRecordSchema,
  opponentNoteMapSchema,
  selectMyCandidateFighterIds,
  SpriteList,
  type GeneratedScoutReport,
  type MatchupEvidence,
  type MyCharacterRecordVsOpponent,
  type OpponentNote,
  type ScoutBinding,
  type ScoutReportData,
} from '@smash-tracker/shared';
import { normalizeOpponentTag } from '../startgg/sync.js';

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

/** Raw-count aggregate of the caller's results against one of the scouted player's top characters. */
export interface MatchupAggregate {
  opponentCharacter: string;
  wins: number;
  losses: number;
  topStages: Array<{ stage: string; wins: number; losses: number }>;
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
}

/**
 * `scout` MUST NOT carry `games` (V9-D's per-game records, added for the
 * web "Full analysis" section) — the payload's own `headToHead`,
 * `vsTopCharacters`, and `matchupAdvisor` already summarize everything a
 * per-game list would add for Claude, so including it here would only
 * inflate token cost for zero grounding benefit. `assembleReportPayload`
 * strips it unconditionally, even when the incoming `scout` has it.
 */
export interface ReportPayload {
  scout: Omit<ScoutReportData, 'games'>;
  headToHead: HeadToHeadMatch[];
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
     */
    matchupAdvisor: Array<{
      opponentCharacter: string;
      ranked: Array<{ character: string; score: number; evidence: MatchupEvidence }>;
    }>;
  };
  notes: OpponentNote | null;
}

const TOP_CHARACTERS_COUNT = 5;
const TOP_STAGES_PER_MATCHUP = 5;
const RECENT_FORM_SAMPLE_SIZE = 50;
const MY_TOP_CHARACTERS_COUNT = 5;

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
  options?: { binding?: ScoutBinding; curatedCanonicalName?: string },
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

  const aliasMap = aliasSnapshot.exists()
    ? (aliasSnapshot.val() as Record<string, string>)
    : ({} as Record<string, string>);

  const rawMatches = matchesSnapshot.exists()
    ? (Object.values(matchesSnapshot.val() as Record<string, unknown>).map((value) =>
        matchRecordSchema.parse(value),
      ) as Array<ReturnType<typeof matchRecordSchema.parse> & { time: number }>)
    : [];

  // Single-hop alias lookup: opponentAliases/{uid} is already transitively
  // flattened by the write path (RtdbService.setOpponentAlias), so one
  // lookup suffices — no need to walk chains here.
  function canonicalOpponentName(name: string | undefined): string {
    const tag = normalizeOpponentTag(name);
    return aliasMap[tag] ?? tag;
  }

  const scoutedCanonicalName = normalizeOpponentTag(scout.player.gamerTag);

  // H2H matching: delegates to `selectOpponentMatches` above. With no
  // `options.binding` (every legacy report), this is byte-identical to the
  // pre-Phase-27 predicate — the `opponentUserSlug` shortcut only ever
  // applies to start.gg-scouted players; for a parry.gg-scouted player
  // (V9-B Feature 4), `scout.player.userSlug` is simply absent, so it
  // naturally falls through to canonicalized-gamerTag matching.
  const matchesVsScoutedPlayer = selectOpponentMatches({
    matches: rawMatches,
    canonicalOpponentName,
    scoutedCanonicalName,
    scoutedPlayerUserSlug: scout.player.userSlug,
    binding: options?.binding,
    curatedCanonicalName: options?.curatedCanonicalName,
  });

  const headToHead: HeadToHeadMatch[] = matchesVsScoutedPlayer
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
    const matchesVsCharacter = rawMatches.filter((match) => match.opponent_id === fighterId);
    const wins = matchesVsCharacter.filter((match) => match.win).length;
    const losses = matchesVsCharacter.length - wins;

    const stageTally = new Map<string, { wins: number; losses: number; games: number }>();
    for (const match of matchesVsCharacter) {
      const name = match.map ? match.map.name : 'Unknown stage';
      const existing = stageTally.get(name) ?? { wins: 0, losses: 0, games: 0 };
      existing.games += 1;
      if (match.win) {
        existing.wins += 1;
      } else {
        existing.losses += 1;
      }
      stageTally.set(name, existing);
    }

    const topStages = [...stageTally.entries()]
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, TOP_STAGES_PER_MATCHUP)
      .map(([stage, tally]) => ({ stage, wins: tally.wins, losses: tally.losses }));

    return {
      opponentCharacter: fighterName(fighterId),
      wins,
      losses,
      topStages,
    };
  });

  const recentMatches = [...rawMatches]
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
    const matchesAsThisCharacter = rawMatches.filter((match) => match.fighter_id === fighterId);
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

    return {
      userCharacter: fighterName(fighterId),
      wins,
      losses,
      vsOpponentCharacter,
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
  const matchupAdvisor = buildMatchupAdvisor(
    topCharacterIds,
    myFighterIds,
    recordsByOpponentFighterId,
  ).map((ranking) => ({
    opponentCharacter: fighterName(ranking.opponentFighterId),
    ranked: ranking.ranked.map((pick) => ({
      character: fighterName(pick.fighterId),
      score: pick.score,
      evidence: pick.evidence,
    })),
  }));

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
        format: ReturnType<typeof zodOutputFormat<typeof generatedScoutReportSchema>>;
      };
    }) => Promise<{
      stop_reason: string | null;
      parsed_output: GeneratedScoutReport | null;
    }>;
  };
}

const REPORT_MODEL = 'claude-opus-4-8';
const REPORT_MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You are a competitive Super Smash Bros. Ultimate coach writing a pre-bracket scouting brief for "you" (the user) about an opponent you are about to play.

Hard rules — follow these exactly:
- Ground every claim in the provided JSON payload ONLY. Never invent results, characters, stages, or events that are not present in the data.
- If a conclusion is drawn from fewer than 5 games of evidence (a character matchup, a stage record, a head-to-head record, etc.), you MUST flag that sample-size caveat explicitly in confidenceNotes.
- Stage names and character names in your output must come VERBATIM from the data provided — do not paraphrase, translate, or invent alternate spellings.
- Be concise and actionable. No filler, no generic advice that isn't grounded in this specific opponent's data.
- The payload contains: "scout" (the opponent's public tournament-site history — their characters, stages, recent events, common opponents), "headToHead" (the user's own past matches against this exact player, if any), "userContext" (the user's own character selections and character-matchup records, the user's raw W/L record against players of the opponent's most-used characters broken down by stage, the user's recent overall form, and a deterministic matchup advisor ranking — see below), and "notes" (a saved tendency note about this opponent, if the user has one).
- When headToHead is empty, set the headToHead field in your response to null — do not fabricate a head-to-head summary.
- Output must conform to the provided JSON schema exactly.

Character strategy is CO-EQUAL in importance with stage strategy — treat characterStrategy with the same rigor and specificity you give stageStrategy, not as an afterthought:
- "userContext.myFighters" lists the user's own primary/secondary character selections. "userContext.myCharacterRecords" gives, for each character the user demonstrably plays (their selections plus their most-used characters by games played), that character's overall W/L and W/L against each of the opponent's top characters.
- "userContext.matchupAdvisor" is a DETERMINISTIC, pre-computed ranking (not generated by you) of the user's own characters against each of the opponent's top-5 characters, blending the user's real record with tier-list/archetype priors — each entry's "evidence" explains why (a record, a tier score, an archetype edge). Treat this ranking as the GROUND TRUTH starting point for characterStrategy: your picks should normally match its top-ranked character for the opponent's most-used character. You MAY explain nuance or adjust for something the ranking can't see (e.g. stage-specific patterns, a saved note), but if your recommendation diverges from the advisor's top pick you MUST say so explicitly and state why in characterStrategy.reasoning — never silently contradict it.
- You MUST recommend picks ONLY from characters that appear in "userContext.myFighters" or "userContext.myCharacterRecords" — NEVER recommend a character the user does not play, even if it would theoretically counter the opponent well.
- characterStrategy.picks must include a game-1 recommendation, and characterStrategy.reasoning must state what to switch to if the opponent changes character (e.g. "Game 1: X; if they swap to Y, counter with Z"), grounded in the user's actual W/L from myCharacterRecords against the opponent's specific top characters and the matchupAdvisor ranking — not generic tier-list reasoning invented from scratch.
- If the user's own character data is too sparse to ground a confident recommendation, say so explicitly in characterStrategy.reasoning and confidenceNotes rather than guessing.`;

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
 * Calls Claude to generate a `GeneratedScoutReport` from the assembled
 * payload. Uses `client.messages.parse` with `output_config.format` built
 * from `zodOutputFormat` (validated against the installed
 * `@anthropic-ai/sdk` version to accept zod v4 schemas directly).
 */
export async function generateScoutReport(
  client: AnthropicLikeClient,
  payload: ReportPayload,
): Promise<GeneratedScoutReport> {
  const response = await client.messages.parse({
    model: REPORT_MODEL,
    max_tokens: REPORT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    output_config: { format: zodOutputFormat(generatedScoutReportSchema) },
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
