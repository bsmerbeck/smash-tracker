import type { Match } from '../match.js';

/**
 * Named sparse and cold-start fixture workspaces (FIXT-02, D-18): zero
 * games, one game, two games, an unknown-stage-only workspace, and an
 * unknown-character-only workspace. Every builder is a deterministic,
 * zero-argument function — no seed needed, since these are fixed, tiny,
 * hand-shaped fixtures rather than a randomized distribution.
 *
 * These are CODE-ONLY, synthetic fixtures — no production tenant, no
 * demo-account read (D-20 forbids Claude reading production data).
 */

/** Never `Date.now()` — a fixed reference point, matching `syntheticMatches.ts`'s discipline. */
const BASE_TIME_MS = 1_700_000_000_000;

/** Fox (`fighterData.ts` id 8) and Marth (id 23) — real roster ids, arbitrary choice. */
const KNOWN_FIGHTER_ID = 8;
const KNOWN_OPPONENT_FIGHTER_ID = 23;
/** Battlefield (`stageData.ts` id 1). */
const KNOWN_STAGE = { id: 1, name: 'Battlefield' };

function makeSparseMatch(id: string, index: number, overrides: Partial<Match> = {}): Match {
  return {
    id,
    fighter_id: KNOWN_FIGHTER_ID,
    opponent_id: KNOWN_OPPONENT_FIGHTER_ID,
    time: BASE_TIME_MS + index * 60_000,
    win: index % 2 === 0,
    matchType: 'offline-tourney',
    ...overrides,
  };
}

/** Zero games — the coldest possible start. Every claim builder must abstain without throwing. */
export function emptyWorkspace(): Match[] {
  return [];
}

/** One game (known stage) — one below the D-05 floor's "1 more game needed" boundary. */
export function oneGameWorkspace(): Match[] {
  return [makeSparseMatch('sparse-one-0', 0, { map: KNOWN_STAGE })];
}

/** Two games (known stage) — the D-05 floor's "1 more game needed" boundary. */
export function twoGameWorkspace(): Match[] {
  return [0, 1].map((index) => makeSparseMatch(`sparse-two-${index}`, index, { map: KNOWN_STAGE }));
}

/**
 * Five games, every one missing `map` entirely — the conditional-spread
 * "unknown stage" shape (never `map: null`). Proves the stage-evidence
 * unknown bucket and abstained stage ranking on a workspace with real games
 * but no known stage data at all (EVID-11).
 */
export function unknownStageOnlyWorkspace(): Match[] {
  return Array.from({ length: 5 }, (_, index) =>
    makeSparseMatch(`sparse-unknown-stage-${index}`, index),
  );
}

/**
 * Five rows carrying a `fighter_id`/`opponent_id` of `0` — the same
 * "unknown" sentinel convention as the stage axis's `map.id === 0`, and a
 * value `matchRecordSchema`'s `.positive()` constraint rejects outright
 * (unlike the stage axis, `fighter_id`/`opponent_id` have no dedicated
 * "unknown" schema value; `0` is deliberately invalid, not merely absent).
 *
 * D-25: no live ingestion path produces this today — `startgg/sync.ts` and
 * `parrygg/sync.ts` both drop a game whose character doesn't map to a known
 * fighter id BEFORE it ever reaches a `Match[]`. This workspace exists ONLY
 * to exercise the engine's unknown-character bucket (`predicate.ts`'s
 * `isUnknownCharacter`) in a synthetic test — do not read a passing test
 * here as evidence of production coverage.
 *
 * The `as Match` below is the single, clearly-named construction site that
 * bypasses `matchRecordSchema`'s validation for this deliberately-invalid
 * fixture; `packages/shared/src/match.ts` itself is not modified (D-17).
 */
export function unknownCharacterOnlyWorkspace(): Match[] {
  const UNKNOWN_FIGHTER_ID = 0;
  return Array.from(
    { length: 5 },
    (_, index) =>
      ({
        id: `sparse-unknown-character-${index}`,
        fighter_id: UNKNOWN_FIGHTER_ID,
        opponent_id: UNKNOWN_FIGHTER_ID,
        time: BASE_TIME_MS + index * 60_000,
        win: index % 2 === 0,
        matchType: 'offline-tourney',
        map: KNOWN_STAGE,
      }) as Match,
  );
}
