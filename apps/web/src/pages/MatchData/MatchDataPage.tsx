import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { useSortedFighters } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import {
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { AddMatchForm } from '@/pages/Dashboard/components/AddMatchForm';
import { MatchTable } from './components/MatchTable';
import { RosterUsage } from './components/RosterUsage';
import { StageBreakdown } from './components/StageBreakdown';
import { MatchDataRail } from './components/MatchDataRail';

const GAMES_ANCHOR_ID = 'games';

/**
 * Ports legacy/src/screens/MatchData. Rebuilt onto the insight-first grid
 * contract (T-39.1-16, UI-SPEC §8.4, owner note 7): `PageShell` -> one filter
 * row (`HorizonSwitch`) -> `PageGrid` rows — the match table full-width, the
 * roster/stage cards an 8-col stack beside the 4-col roster rail, and a
 * conditional `FilteredMatchList` terminus row (T-39.1-14's identical
 * read-side-only precedent: this page writes no drill axis of its own yet,
 * but the read side and the conditional mount are wired now).
 *
 * Phase 30.3 (Gate 4, fighter-preference fallback): when the subject has
 * matches but NO saved primary/secondary favorites (imported demo
 * histories), the page infers a read-only fighter list from the fighters
 * observed in those matches instead of dead-ending on the choose-fighters
 * gate — which now only renders when there is neither a saved selection nor
 * a match to infer from. "Choose favorites" stays available as a
 * non-blocking prompt banner above the real content.
 */
export function MatchDataPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const [searchParams] = useSearchParams();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();
  const { horizon } = useHorizon();

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: a tolerant read of every drill-down axis currently in the URL —
  // this page writes none of them itself yet (RosterUsage/StageBreakdown
  // rows NAVIGATE AWAY to fighter-analysis/stage-detail rather than writing
  // a local axis), but the read side and the conditional terminus row are
  // wired now so future wiring has a mount point (UI-SPEC §10.3).
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );
  const hasDrillAxis =
    axesFromUrl.fighterId != null ||
    axesFromUrl.vsFighterId != null ||
    axesFromUrl.stageId != null ||
    axesFromUrl.eventKey != null ||
    axesFromUrl.from != null ||
    axesFromUrl.to != null;

  const savedFighterIds = useMemo(
    () => [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])],
    [fighterSelection],
  );
  const usingInferredFighters = savedFighterIds.length === 0 && allMatches.length > 0;
  const rawFighterSprites = useMemo<Fighter[]>(() => {
    const ids = usingInferredFighters ? inferFighterIdsFromMatches(allMatches) : savedFighterIds;
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [usingInferredFighters, allMatches, savedFighterIds]);
  // 260725-Q1: alphabetized by localized name — matches every other fighter
  // picker in the app.
  const fighterSprites = useSortedFighters(rawFighterSprites);

  if (fightersLoading || matchesLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-muted-foreground">{t('matchData.loading')}</div>
      </div>
    );
  }

  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
          <p className="max-w-md text-muted-foreground">{t('shared.noFighters.subtitle')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to={subjectPath('/choose-primary')}>
                {t('shared.noFighters.choosePrimary')}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to={subjectPath('/choose-secondary')}>
                {t('shared.noFighters.chooseSecondary')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t('matchData.noMatches')}</h2>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
            <Button asChild variant="outline">
              <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const sortedMatches = sortMatchesNewestFirst(matches);
  const terminusAxes: DrillDownAxes = {
    fighterId: axesFromUrl.fighterId,
    vsFighterId: axesFromUrl.vsFighterId,
    stageId: axesFromUrl.stageId,
    eventKey: axesFromUrl.eventKey,
    from: axesFromUrl.from,
    to: axesFromUrl.to,
  };

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-end gap-6 pt-6">
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {usingInferredFighters && <ChooseFavoritesPrompt />}
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <PageGrid>
        <GridCell span={12}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('matchData.title')}</CardTitle>
              <AddMatchForm fighterSprites={fighterSprites} fighter={fighterSprites[0]} />
            </CardHeader>
            <CardContent>
              <MatchTable matches={matches} fighterSprites={fighterSprites} />
            </CardContent>
          </Card>
        </GridCell>

        <GridCell span={8} stack>
          <RosterUsage matches={matches} />
          <StageBreakdown matches={matches} />
        </GridCell>

        <GridCell span={4}>
          <MatchDataRail matches={matches} horizon={horizon} />
        </GridCell>

        {hasDrillAxis && (
          <GridCell span={12}>
            <Card id={GAMES_ANCHOR_ID} className="scroll-mt-16">
              <CardHeader>
                <CardTitle>{t('matchups.results')}</CardTitle>
              </CardHeader>
              <CardContent>
                <FilteredMatchList matches={sortedMatches} axes={terminusAxes} showDelete />
              </CardContent>
            </Card>
          </GridCell>
        )}
      </PageGrid>
    </PageShell>
  );
}
