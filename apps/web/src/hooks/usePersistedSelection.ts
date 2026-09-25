import { useState } from 'react';
import type { Fighter } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { useAuth } from '@/hooks/useAuth';
import { useEffectiveSubject } from '@/hooks/useEffectiveSubject';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import {
  analyticsSelectionStorageKey,
  persistSelection,
  readStoredSelection,
  type StoredAnalyticsSelection,
} from '@/lib/analyticsSelection';
import {
  orderFightersByUsage,
  rankFighterUsage,
  rankOpponentUsage,
  type FighterUsage,
} from '@/lib/playerTrueDefaults';

export interface PersistedSelectionResult {
  fighter: Fighter | undefined;
  opponent: Fighter | undefined;
  setFighter: (fighter: Fighter) => void;
  setOpponent: (fighter: Fighter) => void;
  /** Games played per fighter id, all-time — for usage badges alongside picker entries (plan 35-02). */
  fighterUsageById: Map<number, number>;
  /** The resolved fighter's faced opponents, most-faced first (plan 35-02's opponent picker grouping). */
  opponentUsage: FighterUsage[];
  /** `fighterSprites`, reordered most-to-least used (D-13) — the picker's render order. */
  orderedFighterSprites: Fighter[];
  isLoading: boolean;
}

/**
 * Phase 35 (Player-True Defaults & Persistence): composes the subject-scoped
 * selection store (`lib/analyticsSelection.ts`) with the usage ranking
 * (`lib/playerTrueDefaults.ts`) into the single remembered-vs-computed
 * fighter/opponent resolution this plan's `MatchupsPage` and plan 35-03's
 * `FighterAnalysisPage` both call — D-12: one stored value shared by both
 * pages, not one per page.
 *
 * Resolution order (D-03/D-07): a remembered fighter wins only when it
 * resolves to a member of `fighterSprites` AND has at least one game in
 * `allMatches` for this subject; otherwise the highest-ranked usage entry
 * that IS a member of `fighterSprites` is used (never the first of the
 * list — there is no roster-first fallback).
 *
 * The opponent's remembered-vs-computed check (D-09/D-10) is gated on a
 * FIGHTER SWITCH, not re-applied on every render for an unchanged fighter —
 * D-10's own wording ("ON FIGHTER SWITCH a computed opponent re-derives...
 * stays only if the NEW fighter has games against it") is a transition
 * rule, not a continuous one. Applying it continuously would silently
 * discard a freshly explicit pick of an opponent the resolved fighter has
 * never faced (e.g. via `MatchupMatrix`'s cell click into an empty pairing,
 * or via `SelectOpponent`'s full-roster picker) on the very next render —
 * that is a real, reachable, and desired UI state (the pairing's own
 * "no matches" empty state), not a defect to correct away from. So: the
 * "has games with this fighter" check runs only at hydration and at the
 * instant `resolvedFighterId` actually changes from what it was on the
 * previous render (tracked via `opponentValidatedForFighterId`). Once a
 * fighter is stable across renders, whatever `record.opponentId` holds is
 * honored as-is, matches or not.
 *
 * The discard itself is committed into `record` (via `setRecord`, not just
 * a local variable) precisely BECAUSE this hook uses the "adjust state
 * during render" pattern: calling a state setter during render makes React
 * discard this render's own return value and immediately re-invoke the
 * whole function with the updated state — so a discard decision that only
 * lived in a local variable would be thrown away on that re-invocation,
 * letting the stale remembered opponent silently survive. Clearing
 * `record.opponentId` (a plain, non-functional `undefined`, never
 * persisted to storage) makes the decision durable across the re-invoke:
 * the very next call reads `record.opponentId` fresh and already sees it
 * cleared. (Refs mutated during render would sidestep the re-invoke
 * entirely, but this codebase's lint config forbids reading/writing
 * `ref.current` during render — `react-hooks/refs` — so the state-based
 * form is used instead.)
 *
 * Nothing is computed, and nothing is written, while the match query is
 * loading (D-16) — `setFighter`/`setOpponent` are the ONLY two call sites
 * of `persistSelection` in this module, which is what closes D-06 (a
 * computed default is never persisted) by construction.
 */
export function usePersistedSelection({
  fighterSprites,
}: {
  fighterSprites: Fighter[];
}): PersistedSelectionResult {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { clientId } = useEffectiveSubject();
  const { allMatches, isLoading } = useFilteredMatches();

  const storageKey = uid ? analyticsSelectionStorageKey(uid, clientId) : null;

  const [seededKey, setSeededKey] = useState(storageKey);
  const [record, setRecord] = useState<StoredAnalyticsSelection>(() =>
    readStoredSelection(uid, clientId),
  );
  // The fighter id the CURRENT `record.opponentId` was last validated
  // against (D-10's fighter-switch gate — see the docstring above).
  // `undefined` means "not yet validated for any fighter", which correctly
  // forces the has-games check at hydration too.
  const [opponentValidatedForFighterId, setOpponentValidatedForFighterId] = useState<
    number | undefined
  >(undefined);

  // React's documented "adjust state when a prop changes" pattern (no
  // effect): when the resolved storage key differs from the one `record`
  // was seeded from, re-seed synchronously during render so a subject
  // switch can never render one subject's selection for another, not even
  // for one frame. This is sound HERE, and only here: this hook is called
  // from pages mounted INSIDE the router, and `useEffectiveSubject()` is a
  // pure `useLocation` parse — already correct on the FIRST render of any
  // navigation. Plan 35-03's `AnalyticsFilterProvider` is mounted ABOVE the
  // router and cannot make the same guarantee; do not copy this pattern
  // there.
  if (storageKey !== seededKey) {
    setSeededKey(storageKey);
    setRecord(readStoredSelection(uid, clientId));
    // Force the opponent's has-games check to re-run against the new
    // subject's resolved fighter, even if that fighter id happens to
    // coincide numerically with the previous subject's.
    setOpponentValidatedForFighterId(undefined);
  }

  if (isLoading) {
    return {
      fighter: undefined,
      opponent: undefined,
      setFighter: () => {},
      setOpponent: () => {},
      fighterUsageById: new Map(),
      opponentUsage: [],
      orderedFighterSprites: [],
      isLoading: true,
    };
  }

  const fighterUsageById = new Map<number, number>();
  for (const usage of rankFighterUsage(allMatches)) {
    fighterUsageById.set(usage.id, usage.games);
  }

  const rememberedFighterId = record.fighterId;
  const rememberedFighterHasMatches =
    rememberedFighterId != null && fighterUsageById.has(rememberedFighterId);
  const rememberedFighterInPicker =
    rememberedFighterId != null &&
    fighterSprites.some((sprite) => sprite.id === rememberedFighterId);

  let resolvedFighterId: number | undefined;
  if (rememberedFighterId != null && rememberedFighterHasMatches && rememberedFighterInPicker) {
    resolvedFighterId = rememberedFighterId;
  } else {
    resolvedFighterId = rankFighterUsage(allMatches).find((usage) =>
      fighterSprites.some((sprite) => sprite.id === usage.id),
    )?.id;
  }

  const fighter = resolvedFighterId != null ? getFighterById(resolvedFighterId) : undefined;

  const opponentUsage =
    resolvedFighterId != null ? rankOpponentUsage(allMatches, resolvedFighterId) : [];

  const rememberedOpponentId = record.opponentId;
  const fighterSwitchedSinceLastOpponentCheck = resolvedFighterId !== opponentValidatedForFighterId;

  if (fighterSwitchedSinceLastOpponentCheck) {
    // D-10: on a fighter switch (including hydration, from `undefined`), a
    // remembered opponent survives only if the NEW fighter has games
    // against it; otherwise it's silently discarded — cleared from the
    // IN-MEMORY session record only (never `persistSelection`d, so the
    // stored value is untouched until the user's next explicit change) —
    // so the decision is durable across the "adjust state during render"
    // re-invoke this setState call itself triggers (see docstring above).
    const rememberedHasMatchesForNewFighter =
      rememberedOpponentId != null &&
      opponentUsage.some((usage) => usage.id === rememberedOpponentId);
    if (!rememberedHasMatchesForNewFighter && rememberedOpponentId != null) {
      setRecord((prev) => ({ ...prev, opponentId: undefined }));
    }
    setOpponentValidatedForFighterId(resolvedFighterId);
  }

  const resolvedOpponentId =
    rememberedOpponentId != null ? rememberedOpponentId : opponentUsage[0]?.id;

  const opponent = resolvedOpponentId != null ? getFighterById(resolvedOpponentId) : undefined;

  function setFighter(next: Fighter): void {
    setRecord((prev) => ({ ...prev, fighterId: next.id }));
    persistSelection(uid, clientId, { fighterId: next.id });
  }

  function setOpponent(next: Fighter): void {
    setRecord((prev) => ({ ...prev, opponentId: next.id }));
    persistSelection(uid, clientId, { opponentId: next.id });
  }

  return {
    fighter,
    opponent,
    setFighter,
    setOpponent,
    fighterUsageById,
    opponentUsage,
    orderedFighterSprites: orderFightersByUsage(fighterSprites, allMatches),
    isLoading: false,
  };
}
