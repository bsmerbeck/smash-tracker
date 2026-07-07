import { PartyPopper } from 'lucide-react';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import {
  ASSUMED_MMR_POINTS_PER_MATCH,
  GSP_MODEL,
  MAX_PROJECTED_MATCHES,
  projectMatchesToElite,
  projectMatchesToEliteMmr,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getRecentGspWinRate } from './GspHero';
import { calibrationFromSettings, computedEliteThreshold, estimateMmrAt } from '../lib/gspMmrModel';
import { useNowMs } from '../lib/useNowMs';

/**
 * The GSP page's projection card (V10.1) — "how far to Elite Smash".
 *
 * PRIMARY: the MMR projection (`projectMatchesToEliteMmr`,
 * packages/shared/src/gspMmr.ts) — Elite entry is a fixed MMR (1142) and,
 * per the community reverse-engineered zero-sum delta system (Elo K=20),
 * even matchmaking trades ~10 MMR per match, so "net wins needed" is a
 * clean, GSP-inflation-free number. Its 'equilibrium' outcome (win rate
 * <= 50%) is an honest result presented kindly — matchmaking has found the
 * player's level, and a >50% win rate (not more grinding) is what moves it.
 *
 * SECONDARY: V10's own-history GSP decay simulation
 * (`projectMatchesToElite`, packages/shared/src/gsp.ts) as a
 * "from your own GSP history" cross-check line, when it can compute.
 */
export function RoadToElite({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const nowMs = useNowMs();
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;
  const winRate = getRecentGspWinRate(series) ?? 0;

  const calibration = calibrationFromSettings(settings);
  const estimate =
    lastPoint !== null ? estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration) : null;
  const mmrProjection =
    estimate !== null ? projectMatchesToEliteMmr(Math.round(estimate.mmr), winRate) : null;

  // Secondary, own-history line (V10): simulate against the COMPUTED
  // GSP threshold. Only meaningful when the primary isn't a
  // celebration/equilibrium state.
  const gspThreshold = computedEliteThreshold(nowMs, calibration);
  const decayProjection =
    lastPoint !== null && mmrProjection !== null && mmrProjection.status === 'projected'
      ? projectMatchesToElite(series, gspThreshold, winRate)
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Road to Elite</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mmrProjection === null ? (
          <p className="text-sm text-muted-foreground">
            Log a match with a GSP reading for this fighter to see a projection.
          </p>
        ) : mmrProjection.status === 'already-elite' ? (
          <div className="flex items-center gap-2 text-emerald-500">
            <PartyPopper className="size-6" />
            <p className="text-lg font-semibold">You&apos;re already in Elite Smash!</p>
          </div>
        ) : mmrProjection.status === 'equilibrium' ? (
          <>
            <p className="text-lg font-semibold">Holding steady at your level</p>
            <p className="text-sm text-muted-foreground">
              At your current {Math.round(winRate * 100)}% win rate, matchmaking thinks this is your
              level right now — every match trades ~{ASSUMED_MMR_POINTS_PER_MATCH} MMR both ways, so
              a &gt;50% win rate is what moves you up, not more matches. Keep working the matchups
              on this page and the number will follow.
            </p>
          </>
        ) : mmrProjection.status === 'capped' ? (
          <>
            <p className="text-2xl font-bold">more than {MAX_PROJECTED_MATCHES} net wins</p>
            <p className="text-sm text-muted-foreground">
              Your win rate is barely above 50%, so expected progress per match is tiny — a small
              bump in win rate shortens this dramatically.
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl font-bold">
              ~{mmrProjection.matchesNeeded} more match
              {mmrProjection.matchesNeeded === 1 ? '' : 'es'}
            </p>
            <p className="text-sm text-muted-foreground">
              to Elite (MMR {GSP_MODEL.ELITE_MMR}) at your ~{ASSUMED_MMR_POINTS_PER_MATCH} MMR/match
              and {Math.round(winRate * 100)}% win rate (community model estimate)
            </p>
            {decayProjection && (
              <p className="text-xs text-muted-foreground">
                From your own GSP history instead: ~{decayProjection.matchesNeededLabel} more match
                {decayProjection.matchesNeededLabel === '1' ? '' : 'es'} (V10&apos;s{' '}
                {decayProjection.model === 'exponential-decay'
                  ? 'shrinking-gains fit'
                  : 'flat-average fallback'}
                ).
              </p>
            )}
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>
                Assumes matchmaking keeps pairing you against similar-MMR opponents (each match
                trades ~{ASSUMED_MMR_POINTS_PER_MATCH} MMR, the community table&apos;s value for an
                even match) and that your recent win rate holds.
              </li>
              <li>
                Built on the community-reverse-engineered MMR model, not Nintendo&apos;s algorithm —
                a simulation, not a guarantee.
              </li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
