import {
  Entrant,
  EventEntrant,
  Game,
  Match,
  MatchContext,
  MatchGame,
  MatchGameParticipant,
  MatchGameSlot,
  MatchState,
  Seed,
  Slot,
  Character,
  Stage,
  User,
} from '@parry-gg/client';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb.js';
import {
  ABSTENTION_FLOOR_GAMES,
  CLAIM_ID_VOCABULARY,
  MIN_VIABLE_CLAIMS,
  StageList,
  type ClaimId,
} from '@smash-tracker/shared';
import type { ParryggMatchContext } from '../parrygg/client.js';
import type { ClaimSelection } from '../reports/claimSelection.js';
import { PARRYGG_SSBU_SLUG } from '../parrygg/sync.js';
import type { FakeDatabase } from './fakeDatabase.js';
import { TEST_UID } from './testApp.js';

/**
 * Phase 39 (plan 39-06, review C3-B1): the VIABLE-EVIDENCE fixture.
 *
 * HAND-AUTHORED, DETERMINISTIC, NO PRODUCTION DATA: every row below is
 * synthetic — no real player's matches, no enrichment-account (sparg0 /
 * MkLeo / IzAw / hbox) rows, no scraped provider payload. Tags are neutral
 * placeholders; the only provider ids are the ones a caller passes in.
 *
 * Why it exists: `routes/reports.test.ts` historically seeded no
 * `matches/{uid}` and stubbed the scouted opponent with an EMPTY set list,
 * so every generation-success case ran against a zero-evidence workspace.
 * That was harmless while the model wrote free prose; once plan 39-07's
 * validator seam and D-21 fail-fast land, a zero-evidence workspace issues
 * fewer than `MIN_VIABLE_CLAIMS` claims and every such case — including
 * cases inside LOCKED describe blocks — would turn into a refund. The
 * fixture gives each affected file a workspace that clears every surface's
 * minimum comfortably, wired at MODULE scope (a same-named `buildTestApp`
 * wrapper) so no locked `describe` body changes by one byte.
 *
 * The shape, and why:
 * - OWN history (`seedViableEvidence`): the user plays one character
 *   against each of THREE distinct opponent characters, `ABSTENTION_FLOOR_GAMES`
 *   games on each of TWO known stages per character — every stage-level
 *   record sits exactly at the floor (evidenced, never abstained), the first
 *   stage always a winning record and the second always a losing one, so the
 *   engine-derived stage lists are stable and unambiguous. Optionally all of
 *   it against the scouted opponent's tag, so the head-to-head family is
 *   non-empty on a tag-matched (no-binding) scout.
 * - OPPONENT public history (start.gg `VIABLE_OPPONENT_SETS_RESPONSE` and
 *   parry.gg `viableParryMatchesList`): the SAME three characters, the SAME
 *   per-character game counts (each at or above the floor, pairwise
 *   distinct so the usage ranking is total), the same two stages — so a
 *   start.gg-scouted and a parry.gg-scouted workspace produce the same
 *   `scout.characters`, and therefore the same stage rows.
 *
 * Nothing here is a literal threshold: the floor and the minimums are
 * imported from `packages/shared`.
 */

/** The user's own character in every seeded match (Mario — a SpriteList id). */
const MY_FIGHTER_ID = 1;
/** A secondary selection the user never plays — present so `secondaryFighters` is seeded too. */
const MY_SECONDARY_FIGHTER_ID = 10;

/** The two known stages every character's history is spread across (SpriteList-independent StageList ids). */
const WINNING_STAGE_ID = 1; // Battlefield
const LOSING_STAGE_ID = 3; // Final Destination

/** Provider mappings for the two stages (start.gg stage id, parry.gg stage slug). */
const STAGE_PROVIDER_KEYS: Readonly<Record<number, { startggId: number; parrySlug: string }>> = {
  [WINNING_STAGE_ID]: { startggId: 311, parrySlug: 'battlefield' },
  [LOSING_STAGE_ID]: { startggId: 328, parrySlug: 'final-destination' },
};

/**
 * The scouted opponent's three characters, with the opponent's public game
 * count on each — at or above the floor and pairwise distinct (so
 * `scout.characters`' games-descending order is total and provider-
 * independent). Fox, Pikachu, Marth.
 */
const OPPONENT_CHARACTERS: ReadonlyArray<{
  fighterId: number;
  startggCharacterId: number;
  parrySlug: string;
  publicGames: number;
}> = [
  {
    fighterId: 8,
    startggCharacterId: 1286,
    parrySlug: 'fox',
    publicGames: ABSTENTION_FLOOR_GAMES + 4,
  },
  {
    fighterId: 9,
    startggCharacterId: 1319,
    parrySlug: 'pikachu',
    publicGames: ABSTENTION_FLOOR_GAMES + 2,
  },
  {
    fighterId: 23,
    startggCharacterId: 1304,
    parrySlug: 'marth',
    publicGames: ABSTENTION_FLOOR_GAMES,
  },
];

/** The character the scouted player's OPPONENTS play in the public history (Mario on start.gg / parry.gg). */
const PUBLIC_OPPONENT_STARTGG_CHARACTER_ID = 1302;
const PUBLIC_OPPONENT_PARRY_SLUG = 'mario';

const BASE_TIME_MS = 1_700_000_000_000;
const MINUTE_MS = 60_000;

function stageRecord(stageId: number): { id: number; name: string } {
  const stage = StageList.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new Error(`viableEvidenceFixture: stage ${stageId} is not in StageList`);
  }
  return { id: stage.id, name: stage.name };
}

/**
 * Seeds `matches/{uid}`, `primaryFighters/{uid}` and `secondaryFighters/{uid}`
 * with the own-history half of the viable workspace. Every row satisfies
 * `matchRecordSchema` (`assembleReportPayload` parses each one, so a
 * malformed row would throw rather than degrade).
 *
 * `options.opponentTag` — when given, every seeded match is against that
 * (lowercased, as the legacy client stores it) tag, so a tag-matched scout
 * sees a non-empty head-to-head. Omitted, the matches are against a neutral
 * placeholder and head-to-head is empty.
 */
export function seedViableEvidence(
  database: FakeDatabase,
  uid: string = TEST_UID,
  options: { opponentTag?: string } = {},
): void {
  const opponent = (options.opponentTag ?? 'fixture sparring partner').toLowerCase();
  const matches: Record<string, unknown> = {};
  let index = 0;
  for (const character of OPPONENT_CHARACTERS) {
    for (const stageId of [WINNING_STAGE_ID, LOSING_STAGE_ID]) {
      for (let game = 0; game < ABSTENTION_FLOOR_GAMES; game += 1) {
        // On the winning stage the user loses only the first game of the
        // floor-sized block; on the losing stage they win only the first.
        const win = stageId === WINNING_STAGE_ID ? game !== 0 : game === 0;
        matches[`fixture-match-${String(index).padStart(3, '0')}`] = {
          fighter_id: MY_FIGHTER_ID,
          opponent_id: character.fighterId,
          time: BASE_TIME_MS + index * MINUTE_MS,
          map: stageRecord(stageId),
          opponent,
          matchType: 'offline-tourney',
          win,
        };
        index += 1;
      }
    }
  }
  database.seed(`matches/${uid}`, matches);
  database.seed(`primaryFighters/${uid}`, [MY_FIGHTER_ID]);
  database.seed(`secondaryFighters/${uid}`, [MY_SECONDARY_FIGHTER_ID]);
}

/**
 * The start.gg player id the viable sets payload attributes the scouted
 * player's games to. It is the SAME synthetic resolve-fixture id every
 * start.gg test in this package already uses (`startgg/scout.test.ts`'s
 * `PLAYER_ID`, `routes/reports.test.ts`'s `RESOLVE_RESPONSE`) — a test
 * fixture constant, not a scraped production row.
 */
export const VIABLE_SCOUTED_PLAYER_ID = 1802316;

/** Builds the start.gg `player.sets` GraphQL `data` payload for `scoutedPlayerId` — the shape `startgg/scout.ts`'s `accumulateScoutSet` consumes. */
export function viableOpponentSetsResponse(scoutedPlayerId: number): unknown {
  const nodes: unknown[] = [];
  let setIndex = 0;
  for (const character of OPPONENT_CHARACTERS) {
    for (let game = 0; game < character.publicGames; game += 1) {
      const stageId = game % 2 === 0 ? WINNING_STAGE_ID : LOSING_STAGE_ID;
      const scoutedWins = game % 2 === 0;
      nodes.push({
        id: 900_000 + setIndex,
        completedAt: 1_700_000_000 + setIndex * 600,
        fullRoundText: 'Winners Round 1',
        round: 1,
        displayScore: scoutedWins ? '1-0' : '0-1',
        totalGames: 1,
        event: {
          id: 7001,
          name: 'Ultimate Singles',
          slug: 'tournament/fixture-weekly/event/ultimate-singles',
          isOnline: false,
          numEntrants: 32,
          videogame: { id: 1386 },
          tournament: { name: 'Fixture Weekly' },
        },
        slots: [
          {
            entrant: {
              id: 1,
              name: 'Scouted Player',
              participants: [{ player: { id: scoutedPlayerId, gamerTag: 'Scouted Player' } }],
              standing: { placement: 5 },
            },
          },
          {
            entrant: {
              id: 2,
              name: 'Fixture Sparring Partner',
              participants: [{ player: { id: 900_001, gamerTag: 'Fixture Sparring Partner' } }],
            },
          },
        ],
        games: [
          {
            winnerId: scoutedWins ? 1 : 2,
            stage: { id: STAGE_PROVIDER_KEYS[stageId]!.startggId, name: stageRecord(stageId).name },
            selections: [
              { character: { id: character.startggCharacterId }, entrant: { id: 1 } },
              { character: { id: PUBLIC_OPPONENT_STARTGG_CHARACTER_ID }, entrant: { id: 2 } },
            ],
          },
        ],
      });
      setIndex += 1;
    }
  }
  return { player: { sets: { pageInfo: { totalPages: 1 }, nodes } } };
}

/** The viable start.gg sets payload for `VIABLE_SCOUTED_PLAYER_ID` — `scoutFetchMock()`'s default sets response. */
export const VIABLE_OPPONENT_SETS_RESPONSE = viableOpponentSetsResponse(VIABLE_SCOUTED_PLAYER_ID);

function parryTimestamp(seconds: number): Timestamp {
  const timestamp = new Timestamp();
  timestamp.setSeconds(seconds);
  return timestamp;
}

function parryUser(id: string, gamerTag: string): User {
  const user = new User();
  user.setId(id);
  user.setGamerTag(gamerTag);
  return user;
}

function parrySeed(id: string, seedNum: number, user: User): Seed {
  const entrant = new Entrant();
  entrant.setId(`entrant-${user.getId()}`);
  entrant.setUsersList([user]);
  const eventEntrant = new EventEntrant();
  eventEntrant.setEntrant(entrant);
  eventEntrant.setSeed(seedNum);
  const seed = new Seed();
  seed.setId(id);
  seed.setSeed(seedNum);
  seed.setEventEntrant(eventEntrant);
  return seed;
}

function parrySlot(slotNum: number, seedId: string, score: number): Slot {
  const slot = new Slot();
  slot.setSlot(slotNum);
  slot.setSeedId(seedId);
  slot.setScore(score);
  return slot;
}

function parryGameSlot(
  slotNum: number,
  userId: string,
  characterSlug: string,
  placement: number,
): MatchGameSlot {
  const character = new Character();
  character.setSlug(characterSlug);
  const participant = new MatchGameParticipant();
  participant.setUserId(userId);
  participant.setCharactersList([character]);
  const gameSlot = new MatchGameSlot();
  gameSlot.setSlot(slotNum);
  gameSlot.setPlacement(placement);
  gameSlot.setParticipantsList([participant]);
  return gameSlot;
}

const PARRY_SPARRING_PARTNER_ID = 'fixture-sparring-partner';

/**
 * The parry.gg `matches.getMatches` list for `parryUserId` — the same three
 * characters, game counts and stages as `VIABLE_OPPONENT_SETS_RESPONSE`, as
 * the `{ toObject() }` messages `parrygg/client.ts`'s `getUserMatches` maps
 * over. One completed single-game match per public game.
 */
export function viableParryMatchesList(
  parryUserId: string,
): Array<{ toObject: () => ParryggMatchContext }> {
  const contexts: ParryggMatchContext[] = [];
  let matchIndex = 0;
  for (const character of OPPONENT_CHARACTERS) {
    for (let game = 0; game < character.publicGames; game += 1) {
      const stageId = game % 2 === 0 ? WINNING_STAGE_ID : LOSING_STAGE_ID;
      const scoutedWins = game % 2 === 0;

      const matchGame = new MatchGame();
      const stage = new Stage();
      stage.setSlug(STAGE_PROVIDER_KEYS[stageId]!.parrySlug);
      matchGame.setStagesList([stage]);
      matchGame.setSlotsList([
        parryGameSlot(0, parryUserId, character.parrySlug, scoutedWins ? 1 : 2),
        parryGameSlot(
          1,
          PARRY_SPARRING_PARTNER_ID,
          PUBLIC_OPPONENT_PARRY_SLUG,
          scoutedWins ? 2 : 1,
        ),
      ]);

      const match = new Match();
      match.setId(`fixture-match-${matchIndex}`);
      match.setRound(1);
      match.setState(MatchState.MATCH_STATE_COMPLETED);
      match.setSlotsList([
        parrySlot(0, 'seed-scouted', scoutedWins ? 1 : 0),
        parrySlot(1, 'seed-partner', scoutedWins ? 0 : 1),
      ]);
      match.setMatchGamesList([matchGame]);
      match.setEndedAt(parryTimestamp(1_700_000_000 + matchIndex * 600));

      const context = new MatchContext();
      context.setMatch(match);
      context.setSeedsList([
        parrySeed('seed-scouted', 5, parryUser(parryUserId, 'Scouted Player')),
        parrySeed(
          'seed-partner',
          12,
          parryUser(PARRY_SPARRING_PARTNER_ID, 'Fixture Sparring Partner'),
        ),
      ]);
      const ssbu = new Game();
      ssbu.setSlug(PARRYGG_SSBU_SLUG);
      context.setGame(ssbu);

      contexts.push(context.toObject());
      matchIndex += 1;
    }
  }
  return contexts.map((context) => ({ toObject: () => context }));
}

/**
 * The claim count every generation-success surface in the consuming test
 * files must clear — the LARGEST `MIN_VIABLE_CLAIMS` among the surfaces
 * those files generate for (the legacy scout, a prep single, a bundle
 * child). Read from the shared export, never typed as a literal (C4-M1).
 */
export const VIABLE_SELECTION_CLAIM_COUNT = Math.max(
  MIN_VIABLE_CLAIMS.scout,
  MIN_VIABLE_CLAIMS.prep_report,
  MIN_VIABLE_CLAIMS.prep_bundle_child,
);

/**
 * C4-M1: the claim ids a generation-success stub selects — exactly the
 * contiguous LOWEST ids `c01`..`c{K}`, `K` = `VIABLE_SELECTION_CLAIM_COUNT`.
 * Claim ids are issued in rank order from `c01` (plan 39-03) over the
 * contiguous `c01`..`c32` vocabulary (plan 39-01), so these are the only ids
 * guaranteed issued under EVERY workspace shape that clears its minimum; a
 * representative spread of non-lowest ids would pass today and become a
 * validator drop (R1) once plan 39-07 wires the validator in.
 */
export const VIABLE_SELECTED_CLAIM_IDS: readonly ClaimId[] = CLAIM_ID_VOCABULARY.slice(
  0,
  VIABLE_SELECTION_CLAIM_COUNT,
);

/**
 * The ONE claim selection every generation-success model stub in the
 * consuming test files returns (plan 39-06: the model's output is a claim
 * SELECTION, `reports/claimSelection.ts`). Its connective prose is lint-clean
 * under plan 39-04's R4/R5 — no digit, no fighter or stage name, no
 * confidence word — so the STORED branch is exercised, never the stripped
 * one. The union of ids across the three sections is exactly
 * `VIABLE_SELECTED_CLAIM_IDS`, with no id above it.
 */
export const VIABLE_CLAIM_SELECTION: ClaimSelection = {
  sections: {
    overview: {
      claimIds: VIABLE_SELECTED_CLAIM_IDS.slice(0, 1),
      connective: 'Keep the opening games steady and patient.',
    },
    gameplan: {
      claimIds: VIABLE_SELECTED_CLAIM_IDS.slice(1, 2),
      connective: 'Steer the set toward the stage where your wins come and stay disciplined there.',
    },
    watchFor: {
      claimIds: VIABLE_SELECTED_CLAIM_IDS.slice(2),
      connective: 'Watch for the same habits late in close games.',
    },
  },
  action1: null,
  action2: null,
  action3: null,
};

/**
 * For the thin-evidence describe blocks plans 39-07/39-08 add (D-21): the
 * OPPOSITE fixture is "nothing seeded" — build the app through the file's
 * aliased BARE harness (`buildBareTestApp`, i.e. `testApp.ts`'s
 * `buildTestApp` imported under an alias) with `emptyScoutFetchMock()` for
 * a start.gg scout, or `parryClients({ ..., matches: 'empty' })` for a
 * parry.gg scout. Never remove the module-level viable seeding every other
 * case depends on.
 */
export const EMPTY_EVIDENCE_NOTE =
  'Thin-evidence cases: use the aliased bare harness (buildBareTestApp) plus emptyScoutFetchMock() / parryClients({ matches: "empty" }) — nothing seeded; never remove the module-level viable seeding.';
