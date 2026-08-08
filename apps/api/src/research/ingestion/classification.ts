import type { ResearchSetClassification } from '@smash-tracker/shared';
import { SSBU_VIDEOGAME_ID, type StartggResearchSet } from '../../startgg/client.js';

/**
 * Phase 30 Plan 03 (ING-03/ING-04/ING-06, review C-H3/C-H4): the ONE
 * written, machine-readable decision table that decides what every provider
 * set IS. `classifyResearchSet` NEVER throws, NEVER mutates its input,
 * NEVER reads the database, and NEVER decides authorization — it is a pure
 * function of one provider set plus the confirmed-player-id set, and it is
 * the single place this phase decides a classification. `sourceLayer.ts`
 * stores every result regardless of classification (D-01, D-03); nothing in
 * this module skips storing a set.
 *
 * `RESEARCH_ELIGIBILITY_RULES` is the shipped, audit-ready version of
 * EXACTLY this decision (ING-01) — plan 30-08 renders it verbatim into
 * `30-COVERAGE-AUDIT.md`. If the code and the table ever disagree, this
 * module's own test suite fails: every rule id `classifyResearchSet` can
 * return exists in the table, and every table entry is exercised by at
 * least one test.
 *
 * The anti-inference guarantee (review C-H3, C-H4) is structural, not a
 * convention to remember: an ABSENT videogame id is `unresolved`
 * (`R-VIDEOGAME-UNKNOWN`), never `non-ssbu` — the provider did not say the
 * set belongs to another game, it said nothing at all. A completed set with
 * an empty `games` array is `no-game-detail` (a named gap), never
 * `walkover` — start.gg routinely returns a real played set with a
 * populated `displayScore` and no per-game rows, so absence of game rows is
 * NOT evidence of a walkover. `walkover` is reachable only from
 * `R-WALKOVER-EXPLICIT`, which requires a provider-stated token in
 * `displayScore`.
 */

export interface ResearchEligibilityRule {
  /** e.g. 'R-NON-SSBU'. */
  id: string;
  classification: ResearchSetClassification;
  /** One sentence, audit-ready — rendered verbatim into `30-COVERAGE-AUDIT.md`. */
  description: string;
  /** The exact provider field(s) consulted by this rule. */
  signal: string;
}

/**
 * `PROVIDER_WALKOVER_TOKENS` is a list of strings the PROVIDER ITSELF must
 * have written into `displayScore`; matching one is reading a provider
 * statement, not deducing an outcome. start.gg exposes no dedicated
 * walkover flag on `Set` or `Entrant`, so if none of these tokens ever
 * appears live, `walkover` is simply unrepresentable through this API and no
 * record will ever carry it — which is the honest result, and which plan
 * 30-08 records in the audit's provider-limitations section rather than
 * papering over. An earlier draft of this plan inferred `walkover` from
 * "completed with no games"; that rule (`R-WALKOVER`) is deleted, and the
 * reason is written here so it cannot be reintroduced as an
 * obvious-looking optimization (review C-H4).
 */
export const PROVIDER_WALKOVER_TOKENS = ['W/O', 'WO', 'WALKOVER'] as const;

/**
 * Populated in EVALUATION ORDER — `classifyResearchSet` implements this
 * table as a straight-line decision (first match wins), and it never
 * returns a rule id absent from this list.
 */
export const RESEARCH_ELIGIBILITY_RULES: readonly ResearchEligibilityRule[] = [
  {
    id: 'R-NON-SSBU',
    classification: 'non-ssbu',
    description:
      "The set's videogame id is present and differs from the SSBU videogame id — the provider said the set belongs to another game.",
    signal: 'event.videogame.id (present, and differs from SSBU_VIDEOGAME_ID)',
  },
  {
    id: 'R-VIDEOGAME-UNKNOWN',
    classification: 'unresolved',
    description:
      "The set's videogame id is absent — the provider said nothing about which game the set belongs to, so the set is unresolved rather than assumed to belong to another game. The set is still STORED and counted; a later phase can revisit it if the provider starts reporting the field.",
    signal: 'event.videogame.id (absent)',
  },
  {
    id: 'R-NON-SINGLES',
    classification: 'non-singles',
    description:
      'Any entrant on the set (checked on every slot, not only the subject) has more than one participant — the set is doubles or better, never singles.',
    signal: 'entrant.participants.length (any entrant)',
  },
  {
    id: 'R-BYE',
    classification: 'bye',
    description: "Fewer than two non-null entrants are present across the set's slots.",
    signal: 'slots[].entrant (presence)',
  },
  {
    id: 'R-DQ-FLAG',
    classification: 'dq',
    description:
      'Any entrant carries the structural disqualification boolean set to true — the PRIMARY DQ signal.',
    signal: 'entrant.isDisqualified (any entrant, primary signal)',
  },
  {
    id: 'R-DQ-DISPLAY',
    classification: 'dq',
    description:
      'No entrant carries the disqualification boolean at all, and displayScore (trimmed, upper-cased) is the literal token "DQ" — a FALLBACK consulted only when no entrant carries the boolean, because the display string has no documented enum.',
    signal: 'displayScore (fallback, only when no entrant carries isDisqualified)',
  },
  {
    id: 'R-WALKOVER-EXPLICIT',
    classification: 'walkover',
    description:
      'displayScore (trimmed, upper-cased) is a member of PROVIDER_WALKOVER_TOKENS — the provider explicitly said walkover.',
    signal: 'displayScore (member of PROVIDER_WALKOVER_TOKENS)',
  },
  {
    id: 'R-NO-GAME-DETAIL',
    classification: 'no-game-detail',
    description:
      'The set has two entrants, no DQ or walkover signal, an empty/absent games array, and a non-null completedAt — a completed set the provider reported with no per-game rows. This is a named gap, NEVER inferred as a walkover.',
    signal: 'games (absent/empty) + completedAt (non-null)',
  },
  {
    id: 'R-NO-GAME',
    classification: 'no-game',
    description: 'The set has an empty/absent games array and a null completedAt.',
    signal: 'games (absent/empty) + completedAt (null)',
  },
  {
    id: 'R-NO-COMPLETED-AT',
    classification: 'no-game',
    description: 'The set has games present but a null completedAt.',
    signal: 'games (present) + completedAt (null)',
  },
  {
    id: 'R-SUBJECT-NOT-FOUND',
    classification: 'unresolved',
    description:
      'The set is an eligible SSBU singles set with games and a completedAt, but no entrant has a participant whose player id is a confirmed player id.',
    signal: 'entrant.participants[].player.id (compared against confirmedPlayerIds)',
  },
  {
    id: 'R-COMPLETE',
    classification: 'complete',
    description:
      'Every other rule declined: an eligible SSBU singles set, with games, a completedAt, and a confirmed subject entrant.',
    signal: '(fall-through — every prior rule declined)',
  },
] as const;

export interface ClassifyResearchSetInput {
  set: StartggResearchSet;
  confirmedPlayerIds: ReadonlySet<string>;
}

export interface ResearchSetClassificationResult {
  classification: ResearchSetClassification;
  ruleId: string;
  subjectEntrantId: string | null;
  opponentEntrantId: string | null;
  gapFlags: {
    unknownOnlineContext: boolean;
    unknownVideogame: boolean;
    missingCompletedAt: boolean;
    missingGameDetail: boolean;
  };
}

type ResearchEntrant = NonNullable<NonNullable<StartggResearchSet['slots']>[number]>['entrant'];

/** Every non-null entrant across the set's slots, order preserved. */
function nonNullEntrants(set: StartggResearchSet): NonNullable<ResearchEntrant>[] {
  return (set.slots ?? []).flatMap((slot) => (slot?.entrant ? [slot.entrant] : []));
}

/**
 * The subject entrant is the one whose participants contain a confirmed
 * player id (coerced to string); the opponent entrant is the OTHER non-null
 * entrant. Computed unconditionally — every branch gets whichever of the
 * two is actually determinable (a bye has a subject but no opponent; a
 * non-SSBU set may have neither) — never re-derived downstream, because
 * `deriveLegacyProjection` (plan 30-03 Task 3) is a pure function of the
 * STORED record and relies on these two ids already being resolved here.
 */
function resolveSubjectAndOpponent(
  entrants: NonNullable<ResearchEntrant>[],
  confirmedPlayerIds: ReadonlySet<string>,
): { subjectEntrantId: string | null; opponentEntrantId: string | null } {
  const subject = entrants.find((entrant) =>
    (entrant.participants ?? []).some(
      (participant) =>
        participant?.player?.id != null && confirmedPlayerIds.has(String(participant.player.id)),
    ),
  );
  if (!subject) {
    return { subjectEntrantId: null, opponentEntrantId: null };
  }
  const opponent = entrants.find((entrant) => entrant.id !== subject.id);
  return {
    subjectEntrantId: String(subject.id),
    opponentEntrantId: opponent ? String(opponent.id) : null,
  };
}

/** A game "misses detail" when it has no winner, or is missing a character selection on either side (review C-H4's named-gap counterpart). */
function gameMissesDetail(game: NonNullable<StartggResearchSet['games']>[number]): boolean {
  if (game.winnerId == null) {
    return true;
  }
  const selections = game.selections ?? [];
  if (selections.length === 0) {
    return true;
  }
  return selections.some((selection) => selection.character?.id == null);
}

/**
 * The single decision table this phase resolves every provider set through.
 * Implements `RESEARCH_ELIGIBILITY_RULES` as a straight-line decision in
 * EXACTLY that evaluation order — first match wins, and the matching rule's
 * id is returned. Never throws, never mutates `input`, never reads the
 * database, never decides authorization.
 */
export function classifyResearchSet(
  input: ClassifyResearchSetInput,
): ResearchSetClassificationResult {
  const { set, confirmedPlayerIds } = input;

  const entrants = nonNullEntrants(set);
  const { subjectEntrantId, opponentEntrantId } = resolveSubjectAndOpponent(
    entrants,
    confirmedPlayerIds,
  );

  const games = set.games ?? [];
  const hasGames = games.length > 0;
  const completedAt = set.completedAt ?? null;
  const videogameId = set.event?.videogame?.id ?? null;

  const gapFlags = {
    unknownOnlineContext: set.event?.isOnline == null,
    unknownVideogame: videogameId == null,
    missingCompletedAt: completedAt == null,
    // Overwritten below once the classification is known — the no-game-detail
    // branch also sets this true, per the module's contract.
    missingGameDetail: hasGames && games.some(gameMissesDetail),
  };

  function result(
    classification: ResearchSetClassification,
    ruleId: string,
  ): ResearchSetClassificationResult {
    return {
      classification,
      ruleId,
      subjectEntrantId,
      opponentEntrantId,
      gapFlags: {
        ...gapFlags,
        missingGameDetail: gapFlags.missingGameDetail || classification === 'no-game-detail',
      },
    };
  }

  // R-NON-SSBU: presence test FIRST — a strict-inequality check against an
  // absent value would silently report every unknown as "belongs to another
  // game" (review C-H3).
  if (videogameId != null && videogameId !== SSBU_VIDEOGAME_ID) {
    return result('non-ssbu', 'R-NON-SSBU');
  }
  if (videogameId == null) {
    return result('unresolved', 'R-VIDEOGAME-UNKNOWN');
  }

  // R-NON-SINGLES: check EVERY entrant, not just the subject's — a doubles
  // set can present the subject as a single participant on one side.
  if (entrants.some((entrant) => (entrant.participants ?? []).length > 1)) {
    return result('non-singles', 'R-NON-SINGLES');
  }

  // R-BYE.
  if (entrants.length < 2) {
    return result('bye', 'R-BYE');
  }

  // R-DQ-FLAG (primary) then R-DQ-DISPLAY (fallback, only when no entrant
  // carries the boolean at all).
  const anyEntrantCarriesDqBoolean = entrants.some((entrant) => entrant.isDisqualified != null);
  if (entrants.some((entrant) => entrant.isDisqualified === true)) {
    return result('dq', 'R-DQ-FLAG');
  }
  const normalizedDisplayScore = set.displayScore?.trim().toUpperCase() ?? '';
  if (!anyEntrantCarriesDqBoolean && normalizedDisplayScore === 'DQ') {
    return result('dq', 'R-DQ-DISPLAY');
  }

  // R-WALKOVER-EXPLICIT — the provider said walkover, so the record says
  // walkover. Never reached from an absence (review C-H4).
  if (
    (PROVIDER_WALKOVER_TOKENS as readonly string[]).includes(normalizedDisplayScore) &&
    normalizedDisplayScore !== ''
  ) {
    return result('walkover', 'R-WALKOVER-EXPLICIT');
  }

  // R-NO-GAME-DETAIL / R-NO-GAME / R-NO-COMPLETED-AT.
  if (!hasGames && completedAt != null) {
    return result('no-game-detail', 'R-NO-GAME-DETAIL');
  }
  if (!hasGames && completedAt == null) {
    return result('no-game', 'R-NO-GAME');
  }
  if (hasGames && completedAt == null) {
    return result('no-game', 'R-NO-COMPLETED-AT');
  }

  // R-SUBJECT-NOT-FOUND / R-COMPLETE.
  if (subjectEntrantId == null) {
    return result('unresolved', 'R-SUBJECT-NOT-FOUND');
  }
  return result('complete', 'R-COMPLETE');
}
