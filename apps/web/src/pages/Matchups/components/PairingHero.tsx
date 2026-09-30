import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, HorizonKey, Insight, Match, PeriodSeries } from '@smash-tracker/shared';
import { confidenceTierFor } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { HorizonStatRow } from '@/components/analytics/HorizonStatRow';
import { MatchTypeShareBar } from '@/components/analytics/MatchTypeShareBar';
import type { InsightDoorDescriptor } from '@/components/analytics/insightDoors';
import { localizedFighterName } from '@/lib/fighterNames';
import { formatMonthSpan } from '@/lib/dateSpan';
import { MATCHUP_MATRIX_ANCHOR_ID } from '../lib/matchupAnchors';
import { MatchupChart, renderFormNowHead } from './MatchupChart';

/** `●●● / ●●○ / ●○○ / ○○○` — duplicated from `FighterHero.tsx`'s own private map (the small-helper-duplication convention). */
const CONFIDENCE_GLYPHS: Record<'high' | 'medium' | 'low' | 'none', string> = {
  high: '●●●',
  medium: '●●○',
  low: '●○○',
  none: '○○○',
};

export interface PairingHeroProps {
  /** The page's `useId()` for the heading — the page's own detail region is named by it too. */
  headingId: string;
  fighter: Fighter;
  opponent: Fighter;
  /** The pairing's games (already pairing-filtered by the page). */
  matchupMatches: Match[];
  /** The page's ONE `formNow` (shared with its terminus); `null` for a pairing with no games. */
  formNowInsight: Insight | null;
  /** The counted-games door `buildInsightDoors` built from `formNowInsight` (the page's anchor and pairing carry); `undefined` for a zero-game window. */
  gamesDoor?: InsightDoorDescriptor;
  /** The page's ONE `buildMatchupPeriodSeries` result (its terminus resolves trend-point drills against it). */
  periodSeries: PeriodSeries;
  /** The page's ONE persisted horizon — the hero's figures are a SECOND control for this same value. */
  horizon: HorizonKey;
  setHorizon: (next: HorizonKey) => void;
  /** True while the match query is in flight — a figure click writes nothing (T-39.1-14-03). */
  isLoading: boolean;
  /** The clock `formNowInsight` was built with (D-06 / D-12). */
  nowMs: number;
}

/**
 * Plan 39.1-44 (sketch 003 A `heroCard`, brief section 1 M3-M6): the
 * pairing's evidence board, ported from the Fighter hero and built only from
 * the kit pieces it uses — identity (both sprites, "A vs B" as the page h1,
 * "N games · span · confidence"), the FormNow claim chip + meta + verdict +
 * evidence, `HorizonStatRow`, the labelled strip and quarterly trend
 * (`MatchupChart`), `MatchTypeShareBar`, and the doors as the LAST row
 * ("See the N games" primary, "Other pairings" to the matrix). There is no
 * separate record card: the StatRow is the record (PD-44-2).
 *
 * No hooks other than `useTranslation` / one `useMemo` — both run before the
 * zero-game branch, so the hook order never changes.
 */
export function PairingHero({
  headingId,
  fighter,
  opponent,
  matchupMatches,
  formNowInsight,
  gamesDoor,
  periodSeries,
  horizon,
  setHorizon,
  isLoading,
  nowMs,
}: PairingHeroProps) {
  const { t, i18n } = useTranslation();

  const span = useMemo(() => {
    if (matchupMatches.length === 0) return null;
    let first = Infinity;
    let last = -Infinity;
    for (const match of matchupMatches) {
      if (match.time < first) first = match.time;
      if (match.time > last) last = match.time;
    }
    return { first, last };
  }, [matchupMatches]);

  const heading = t('matchups.pairingHeading', {
    fighter: localizedFighterName(fighter.id, t),
    opponent: localizedFighterName(opponent.id, t),
  });
  const total = matchupMatches.length;
  const tier = confidenceTierFor(total);
  // A pairing under the 3-game floor has no tier; its honest cue is "low".
  const confidence = t(`insights.evidence.tier.${tier ?? 'low'}`);
  const identityMeta = t('matchups.hero.identityMeta', {
    count: total,
    span: span ? formatMonthSpan(span.first, span.last, i18n.language, ' – ') : '',
    confidence,
  });

  const identity = (
    <div className="flex flex-wrap items-center gap-3" data-slot="pairing-hero-identity">
      <span className="inline-flex flex-none items-center">
        <img src={fighter.url} alt="" className="size-10 object-contain" />
        <span aria-hidden="true" className="mx-1 text-xs text-muted-foreground">
          {t('matchups.vs')}
        </span>
        <img src={opponent.url} alt="" className="size-10 object-contain" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 id={headingId} className="text-xl leading-6 font-semibold">
          {heading}
        </h1>
        {total > 0 && (
          <p className="flex items-center gap-1 text-xs leading-4 text-muted-foreground tabular-nums">
            <span aria-hidden="true">{CONFIDENCE_GLYPHS[tier ?? 'none']}</span>
            <span>{identityMeta}</span>
          </p>
        )}
      </div>
    </div>
  );

  if (total === 0) {
    return (
      <Card>
        <CardContent>
          <section
            data-slot="pairing-hero"
            aria-labelledby={headingId}
            className="flex min-w-0 flex-col gap-4"
          >
            {identity}
            <p className="text-sm text-muted-foreground">{t('matchups.record.empty')}</p>
          </section>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <section
          data-slot="pairing-hero"
          aria-labelledby={headingId}
          className="flex min-w-0 flex-col gap-4"
        >
          {identity}

          {formNowInsight && (
            <div data-slot="pairing-hero-verdict">
              {renderFormNowHead(
                formNowInsight,
                opponent.id,
                t,
                i18n.language,
                t(`fighterAnalysis.hero.verdictMeta.${horizon}`),
              )}
            </div>
          )}

          <HorizonStatRow
            matches={matchupMatches}
            horizon={horizon}
            onSelectHorizon={setHorizon}
            disabled={isLoading}
            nowMs={nowMs}
          />

          <MatchupChart
            matchupMatches={matchupMatches}
            horizon={horizon}
            periodSeries={periodSeries}
            nowMs={nowMs}
          />

          <MatchTypeShareBar matches={matchupMatches} horizon={horizon} nowMs={nowMs} />

          <div className="flex flex-wrap gap-2" data-slot="matchup-form-now-doors">
            {gamesDoor && (
              <Button asChild size="sm">
                <Link to={gamesDoor.href}>
                  {t('insights.door.seeGames', { count: gamesDoor.count })}
                </Link>
              </Button>
            )}
            <Button asChild size="sm" variant="outline">
              <a href={`#${MATCHUP_MATRIX_ANCHOR_ID}`}>{t('matchups.hero.otherPairings')}</a>
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
