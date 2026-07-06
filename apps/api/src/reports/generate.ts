import type { Database } from 'firebase-admin/database';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  generatedScoutReportSchema,
  matchRecordSchema,
  opponentNoteMapSchema,
  SpriteList,
  type GeneratedScoutReport,
  type OpponentNote,
  type ScoutReportData,
} from '@smash-tracker/shared';
import { normalizeOpponentTag } from '../startgg/sync.js';

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

export interface ReportPayload {
  scout: ScoutReportData;
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
  };
  notes: OpponentNote | null;
}

const TOP_CHARACTERS_COUNT = 5;
const TOP_STAGES_PER_MATCHUP = 5;
const RECENT_FORM_SAMPLE_SIZE = 50;
const MY_TOP_CHARACTERS_COUNT = 5;

/**
 * Assembles the JSON payload handed to Claude: the scout data verbatim, the
 * caller's own head-to-head history against this specific player, raw-count
 * aggregates against players of similar characters, and any saved opponent
 * note. Every aggregate here is a RAW COUNT — no Wilson/statistics — the
 * model is instructed (see SYSTEM_PROMPT) to caveat small samples itself.
 */
export async function assembleReportPayload(
  uid: string,
  scout: ScoutReportData,
  database: Database,
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

  const matchesVsScoutedPlayer = rawMatches.filter((match) => {
    if (
      match.opponentUserSlug &&
      scout.player.userSlug &&
      match.opponentUserSlug === scout.player.userSlug
    ) {
      return true;
    }
    return canonicalOpponentName(match.opponent) === scoutedCanonicalName;
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
  // recommend characters the user demonstrably plays.
  const gamesPlayedByFighterId = new Map<number, number>();
  for (const match of rawMatches) {
    gamesPlayedByFighterId.set(
      match.fighter_id,
      (gamesPlayedByFighterId.get(match.fighter_id) ?? 0) + 1,
    );
  }
  const myTopFighterIds = [...gamesPlayedByFighterId.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MY_TOP_CHARACTERS_COUNT)
    .map(([fighterId]) => fighterId);

  const myFighterIds = new Set<number>([
    ...primaryFighterIds,
    ...secondaryFighterIds,
    ...myTopFighterIds,
  ]);

  const myCharacterRecords: CharacterRecord[] = [...myFighterIds].map((fighterId) => {
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

  return {
    scout,
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
- The payload contains: "scout" (the opponent's public start.gg history — their characters, stages, recent events, common opponents), "headToHead" (the user's own past matches against this exact player, if any), "userContext" (the user's own character selections and character-matchup records, the user's raw W/L record against players of the opponent's most-used characters broken down by stage, and the user's recent overall form), and "notes" (a saved tendency note about this opponent, if the user has one).
- When headToHead is empty, set the headToHead field in your response to null — do not fabricate a head-to-head summary.
- Output must conform to the provided JSON schema exactly.

Character strategy is CO-EQUAL in importance with stage strategy — treat characterStrategy with the same rigor and specificity you give stageStrategy, not as an afterthought:
- "userContext.myFighters" lists the user's own primary/secondary character selections. "userContext.myCharacterRecords" gives, for each character the user demonstrably plays (their selections plus their most-used characters by games played), that character's overall W/L and W/L against each of the opponent's top characters.
- You MUST recommend picks ONLY from characters that appear in "userContext.myFighters" or "userContext.myCharacterRecords" — NEVER recommend a character the user does not play, even if it would theoretically counter the opponent well.
- characterStrategy.picks must include a game-1 recommendation, and characterStrategy.reasoning must state what to switch to if the opponent changes character (e.g. "Game 1: X; if they swap to Y, counter with Z"), grounded in the user's actual W/L from myCharacterRecords against the opponent's specific top characters — not generic tier-list reasoning.
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
