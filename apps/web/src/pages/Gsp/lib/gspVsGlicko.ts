import {
  VALUE_SERIES_GRAIN_LADDER,
  buildValueSeries,
  type ValueSeries,
  type ValueSeriesGrain,
  type ValueSeriesReading,
} from '@smash-tracker/shared';
import type { RatingPeriodResult } from '@/lib/glicko';
import type { MmrPoint } from './gspMmrModel';

/** Minimum points required in EITHER series before the "MMR vs Glicko-2" card renders. */
export const GSP_VS_GLICKO_MIN_POINTS = 3;

/** The default line-chart mark bound (UI-SPEC 9.1): each panel draws at most this many points. */
const GSP_VS_GLICKO_TARGET = 60;
/** Re-grain passes before the shared grain gives up agreeing (the ladder has five rungs, so four suffice). */
const MAX_GRAIN_PASSES = 5;

/**
 * The one visibility gate for the "Est. MMR vs Glicko-2" card: the selected fighter's reading count and
 * the account's rating-period count must both reach `GSP_VS_GLICKO_MIN_POINTS`. The page (which decides
 * whether the Rating-model note spans the whole row) and the card read this same helper, so the two can
 * never disagree about whether the card is drawn.
 */
export function shouldShowGspVsGlicko(gspSeriesLength: number, periodCount: number): boolean {
  return gspSeriesLength >= GSP_VS_GLICKO_MIN_POINTS && periodCount >= GSP_VS_GLICKO_MIN_POINTS;
}

export interface GspVsGlickoPanels {
  /** The grain both panels share (the coarser of the two natural picks). */
  grain: ValueSeriesGrain;
  /** [earliest, latest] point time across both panels - the one x domain every panel is drawn on. */
  xDomain: [number, number];
  /** The selected fighter's estimated MMR - raw values, `memberIndexes` index the MMR series (and so the GSP series). */
  mmr: ValueSeries;
  /** The account-wide Glicko-2 session closes - raw ratings, `memberIndexes` index the rating periods. */
  glicko: ValueSeries;
}

function grainRank(grain: ValueSeriesGrain): number {
  return VALUE_SERIES_GRAIN_LADDER.indexOf(grain);
}

/**
 * Builds the two stacked panels of the "Est. MMR vs Glicko-2" small multiples (plan 41-07, A3): the
 * selected fighter's GSP readings CONVERTED TO ESTIMATED MMR (V10.1 - see `gspMmrModel.ts`) and the
 * player's OVERALL Glicko-2 rating history (every fighter - `computeRatingHistory`). The two scales are
 * unrelated, so neither series is rescaled: each panel keeps its own raw values and the host fits each
 * panel's own y axis. Only the time axis is shared.
 *
 * Both panels are binned by shared `buildValueSeries` at the SAME grain: each is built at its natural
 * grain for a 60-point bound, and while the two disagree both are rebuilt with `minGrain` set to the
 * coarser until they agree, so a close in one panel is the same span of time as a close in the other.
 * Each Glicko point is stamped at its period's END (a period covers a whole session, not one instant).
 */
export function buildGspVsGlickoPanels({
  mmr,
  periods,
}: {
  mmr: MmrPoint[];
  periods: RatingPeriodResult[];
}): GspVsGlickoPanels {
  const mmrReadings: ValueSeriesReading[] = mmr.map((point) => ({
    atMs: point.time,
    value: point.mmr,
    // V17: a calibration reading (`win: null`) is a manual re-baseline, drawn as a diamond.
    calibration: point.win === null,
  }));
  const glickoReadings: ValueSeriesReading[] = periods.map((period) => ({
    atMs: period.end,
    value: period.rating,
    calibration: false,
  }));

  let mmrSeries = buildValueSeries(mmrReadings, { target: GSP_VS_GLICKO_TARGET });
  let glickoSeries = buildValueSeries(glickoReadings, { target: GSP_VS_GLICKO_TARGET });
  for (let pass = 0; pass < MAX_GRAIN_PASSES && mmrSeries.grain !== glickoSeries.grain; pass += 1) {
    const minGrain =
      grainRank(mmrSeries.grain) > grainRank(glickoSeries.grain)
        ? mmrSeries.grain
        : glickoSeries.grain;
    mmrSeries = buildValueSeries(mmrReadings, { target: GSP_VS_GLICKO_TARGET, minGrain });
    glickoSeries = buildValueSeries(glickoReadings, { target: GSP_VS_GLICKO_TARGET, minGrain });
  }

  const xs = [...mmrSeries.points, ...glickoSeries.points].map((point) => point.xMs);
  const xDomain: [number, number] = xs.length === 0 ? [0, 0] : [Math.min(...xs), Math.max(...xs)];

  return { grain: mmrSeries.grain, xDomain, mmr: mmrSeries, glicko: glickoSeries };
}
