/**
 * The Glicko-2 engine (and the session-based rating-history model built on
 * top of it) moved to `@smash-tracker/shared` in V7-D, so the API can
 * compute the same ratings server-side for group leaderboards without
 * forking the implementation. This file is now a thin re-export so existing
 * `@/lib/glicko` imports (Dashboard's HeroStats, Trends' RatingCurve) keep
 * working unchanged. See `packages/shared/src/glicko.ts` for the
 * implementation and its tests.
 */
export {
  TAU,
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_VOLATILITY,
  GLICKO_SCALE,
  updateRating,
  computeRatingHistory,
  splitIntoSessions,
  type GlickoRating,
  type GlickoOpponentResult,
  type RatingPeriodResult,
  type RatingHistory,
} from '@smash-tracker/shared';
