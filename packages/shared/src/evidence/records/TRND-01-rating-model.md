# TRND-01: Session Glicko-2 rating model — fixed-reference fix (v1 -> v2)

**Decision:** FIX the session Glicko-2 rating model. Do not drop it. Decided by the project owner
(bsmerbeck), recorded during Phase 36 (Evidence Engine Foundation & Scale Gate), plan 36-04.

## The defect (v1)

Every session was scored against a SYNTHETIC opponent whose rating equaled the player's own
pre-session rating:

```ts
const preRating = current.rating;
const results = Array.from({ length: games }, (_, i) => ({
  opponentRating: preRating,
  opponentRd: DEFAULT_RD,
  score: i < wins ? 1 : 0,
}));
```

Glicko-2's expected-score function `E(mu, mu_opponent, phi_opponent)` evaluates to exactly `0.5`
whenever `mu_opponent === mu`. Because the synthetic opponent's rating was pinned to the player's
own rating every single session, the expected score was `0.5` forever, no matter how high the
rating climbed — there was no restoring force. A session win rate consistently above 50% produced
a positive rating delta every session, forever: an unbounded biased random walk, not a converging
statistic.

## The fix (v2)

Replace the self-referencing opponent with a FIXED, CONSTANT reference opponent:

- `SESSION_REFERENCE_RATING = 1500` (`DEFAULT_RATING`)
- `SESSION_REFERENCE_RD = 350` (`DEFAULT_RD`)

These are the system's own new/unrated-player defaults, chosen deliberately over inventing a new
constant — a rating reads as "performance relative to a neutral baseline" with no additional
magic number to justify.

With a constant reference, the expected score `E` rises monotonically as the player's own rating
rises, so a constant win rate `p` stops producing a positive delta once the expected score reaches
`p`. That is a genuine fixed point for ANY constant win rate `p ∈ (0, 1)`. At `p = 0.5` the fixed
point is the reference rating itself (1500) — the degenerate, sanity-checkable case.

## Model version

`RATING_MODEL_VERSION = 2`, a compile-time tag added to `RatingHistory.current.ratingModelVersion`
and to `LeaderboardEntry.ratingModelVersion` (Groups API). This is NOT a per-user migration flag —
nothing about a rating is ever stored (see below) — it is simply the version every fresh
computation is currently tagged with.

## Historical recompute: no backfill needed

Ratings are never persisted. `computeRatingHistory` is called fresh over `Match[]`:

- on every web render (Dashboard `HeroStats`, Trends `RatingCurve`/`TrendsHero`, GSP
  `GspVsGlicko`);
- on every Groups API leaderboard request that misses the in-memory cache (`CACHE_TTL_MS`, a
  five-minute TTL — the ONLY caching layer; there is no persisted/RTDB rating cache).

Because there is no stored `v1` value to migrate away from, the "full-history recompute" required
by this decision is a property of the math, not an operational migration: the moment the shared
function changes, every subsequent call computes under v2 automatically. No cursor, batch job, or
dual-read period exists or is needed.

## User-visible consequence and its disclosure

A rating may differ from what a user remembers, because the full history is now scored against the
fixed reference instead of the old self-referencing walk. This is disclosed via a dismissible
"rating model updated" note (`RatingModelNote`, `apps/web/src/components/RatingModelNote.tsx`),
rendered once per page, above the first rating-bearing region, on every affected surface, until the
user dismisses it. The dismissal key is scoped by both the viewer and the rating-model version, so
a FUTURE model version bump surfaces a fresh note rather than inheriting an old dismissal.

## Convergence-test evidence

A deterministic session series (300 sessions, 10 games each, spaced past the session gap so each
session is its own rating period) was run at two constant win rates, before and after the fix:

| Win rate | v1 (pre-fix) final rating                                | v2 (post-fix) final rating                                                                    |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 50%      | 1500 (flat — self-reference is symmetric at exactly 50%) | 1500 (the degenerate fixed point)                                                             |
| 70%      | 7351, still climbing — no restoring force                | ~1720, converged (mean absolute period-over-period delta over the last 20 periods is below 5) |

The 70% case is the must-fail evidence: the same assertion (`current.rating < 3000`) fails against
the v1 model (`7351`) and passes against the v2 model. See `packages/shared/src/glicko.test.ts`'s
`v2 fixed-reference session model (TRND-01)` describe block.

## Surfaces affected (all four, disclosed by the note)

1. Dashboard — `HeroStats` (the rating card).
2. Trends — `RatingCurve` and `TrendsHero`.
3. Groups — the friend leaderboard (`GroupLeaderboardTable`/`GroupLeaderboardHeader`), computed
   server-side via the same shared function (`apps/api/src/groups/groups.ts`'s
   `toLeaderboardEntry`) — no second rating implementation.
4. GSP — `GspVsGlicko`, which plots the session Glicko-2 rating curve alongside estimated MMR; its
   plotted `RatingPeriodResult` values move under v2 exactly like the other three surfaces.
