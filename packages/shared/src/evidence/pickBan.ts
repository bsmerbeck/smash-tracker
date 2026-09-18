/**
 * D-15: the ONE pick/ban split. Before this module, "the top 3, bottom 3"
 * split lived twice — once as `apps/web/src/pages/Matchups/components/
 * CounterpickAdvisor.tsx`'s module-local `PICK_BAN_COUNT` constant plus its
 * own slice, and once again as an equivalent but independently-maintained
 * calculation the Advisor Retrospective (plan 37-06) would otherwise have
 * needed to write from scratch — two copies with no shared source that could
 * silently drift from each other (the same drift class D-15 exists to
 * close). Every caller now imports `pickBanSplit` rather than re-deriving
 * the split.
 *
 * Ordering contract: `ranked` is assumed best-first (the shape every
 * `rankByWilson`-derived list already is). `picks` is the leading slice, in
 * that same best-first order. `bans` is the trailing slice — sized to never
 * overlap `picks` — reversed into worst-first order. When `ranked` has too
 * few items left after `picks` to form a disjoint tail, `bans` is empty
 * rather than reusing any pick.
 */
export const PICK_BAN_COUNT = 3;

export function pickBanSplit<T>(ranked: T[]): { picks: T[]; bans: T[] } {
  const picks = ranked.slice(0, PICK_BAN_COUNT);
  const banCount = Math.min(PICK_BAN_COUNT, ranked.length - picks.length);
  const bans = banCount > 0 ? ranked.slice(ranked.length - banCount).reverse() : [];
  return { picks, bans };
}
