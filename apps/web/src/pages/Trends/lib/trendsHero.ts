import type { Match } from '@smash-tracker/shared';
import { computeRatingHistory, type RatingHistory } from '@/lib/glicko';
import {
  getLastNMatches,
  getMonthlyRecords,
  getWinLossRecord,
  type MonthlyRecord,
} from '@/lib/stats';

/** Minimum games in a month before it's eligible to be called out as the "best month" — mirrors `MonthlyPerformance`'s small-sample threshold intent, kept as its own constant since the hero row's bar is slightly stricter. */
export const BEST_MONTH_MIN_GAMES = 5;

/** Window size for the "current form" win rate in the hero row. */
export const CURRENT_FORM_WINDOW = 20;

export interface TrendsHeroData {
  /** Current Glicko-2 rating ± RD, or null before the rating curve unlocks (fewer than 5 games). */
  currentRating: { rating: number; rd: number } | null;
  /** Peak rating across the account's full rating history (max across all periods, including the current one), or null with no periods yet. */
  peakRating: number | null;
  /** The calendar month with the highest win rate among months with at least `BEST_MONTH_MIN_GAMES` games, or null if no month qualifies. */
  bestMonth: MonthlyRecord | null;
  /** Win rate (0-100) over the last `CURRENT_FORM_WINDOW` games (fewer if the account has less history). */
  currentFormWinRate: number;
  /** How many games the current-form win rate is actually computed over (min(matches.length, CURRENT_FORM_WINDOW)). */
  currentFormGames: number;
}

/**
 * Pure computations backing the Trends hero stat row (V9-C): current rating
 * ±RD, peak rating, best month (win-rate leader with a minimum sample), and
 * current form. Derived entirely from data the page already fetches/computes
 * (rating history + monthly records) — no additional API calls, mirroring
 * FighterAnalysis's `buildFighterHero` pattern.
 */
export function buildTrendsHero(matches: Match[]): TrendsHeroData {
  const { periods, current }: RatingHistory = computeRatingHistory(matches);
  const currentRating = current ? { rating: current.rating, rd: current.rd } : null;
  const peakRating = periods.length > 0 ? Math.max(...periods.map((p) => p.rating)) : null;

  const monthlyRecords = getMonthlyRecords(matches);
  const eligibleMonths = monthlyRecords.filter((r) => r.total >= BEST_MONTH_MIN_GAMES);
  const bestMonth =
    eligibleMonths.length > 0
      ? eligibleMonths.reduce((best, r) => (r.winRate > best.winRate ? r : best))
      : null;

  const recentMatches = getLastNMatches(matches, CURRENT_FORM_WINDOW);
  const { winRate: currentFormWinRate } = getWinLossRecord(recentMatches);

  return {
    currentRating,
    peakRating,
    bestMonth,
    currentFormWinRate,
    currentFormGames: recentMatches.length,
  };
}
