import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { PageShell } from '@/components/analytics/PageShell';
import { PageGrid, GridCell } from '@/components/analytics/PageGrid';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useHorizon } from '@/hooks/useHorizon';
import { usePersistedSelection } from '@/hooks/usePersistedSelection';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';
import { inferFighterIdsFromMatches } from '@/lib/inferredFighters';
import { ChooseFavoritesPrompt } from '@/components/ChooseFavoritesPrompt';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { buildOpponentEvidence } from '@/lib/stats';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';
import {
  buildDrillDownSearch,
  readDrillDownParams,
  sortMatchesNewestFirst,
  type DrillDownAxes,
} from '@/lib/drillDownParams';
import { SelectFighter } from './components/SelectFighter';
import { FighterHero } from './components/FighterHero';
import { FighterInsightRail } from './components/FighterInsightRail';
import { VsCharactersList } from './components/VsCharactersList';
import { VsPlayersList } from './components/VsPlayersList';
import { StageMastery } from './components/StageMastery';
import { MatchupCoverage } from './components/MatchupCoverage';
import { PracticeRecommendations } from './components/PracticeRecommendations';
import { MatchupStageGuide } from './components/MatchupStageGuide';
import { OpponentTable, type OpponentTableRow } from './components/OpponentTable';

const GAMES_ANCHOR_ID = 'games';

/**
 * Fighter Analysis command center, rebuilt onto the insight-first grid
 * contract (T-39.1-14, UI-SPEC §8.1): `PageShell` → one filter row →
 * `PageGrid` rows. The hero leads at every width (DD-07) — it is always the
 * first grid cell in DOM order; only the `xl:col-span-4` rail cell shares
 * its row at >=1280px (UI-SPEC §6.6's placement table). Ports
 * legacy/src/screens/FighterAnalysis.
 */
export function FighterAnalysisPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const [searchParams] = useSearchParams();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const { matches, allMatches, isLoading: matchesLoading, filterActive } = useFilteredMatches();
  const { data: aliasMap } = useOpponentAliases();
  const { horizon, setHorizon, isLoading: horizonLoading } = useHorizon();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `OpponentsPage.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  const stageIds = useMemo(() => new Set(stagesById.keys()), []);
  // D-05: a tolerant read of every drill-down axis currently in the URL —
  // this page writes none of them itself yet (no in-page control narrows by
  // stage/event/date-range within this plan; the terminus list below is
  // reachable today only via a URL a future plan's click handler writes),
  // but the read side and the conditional terminus row are wired now so
  // that future wiring has a mount point (UI-SPEC §10.3).
  const axesFromUrl = useMemo(
    () => readDrillDownParams(searchParams, { stageIds }),
    [searchParams, stageIds],
  );
  const hasDrillAxis =
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

  const { fighter, setFighter, orderedFighterSprites, fighterUsageById } = usePersistedSelection({
    fighterSprites: rawFighterSprites,
  });

  if (fightersLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('fighterAnalysis.loading')}</div>;
  }

  if (orderedFighterSprites.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t('shared.noFighters.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('fighterAnalysis.noFightersSubtitle')}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to={subjectPath('/choose-primary')}>{t('shared.noFighters.choosePrimary')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={subjectPath('/choose-secondary')}>
              {t('shared.noFighters.chooseSecondary')}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('shared.noMatches.title')}</h2>
        <p className="text-muted-foreground">{t('shared.noMatches.subtitle')}</p>
        <Button asChild className="mt-2">
          <Link to={subjectPath('/dashboard')}>{t('common.goToDashboard')}</Link>
        </Button>
      </div>
    );
  }

  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];

  // Phase 38-07 (H-02/Q11.4): the own-subject host consumes the SAME
  // identity-resolving inventory the opponents list/hub already use, rather
  // than the legacy raw-tag `getOpponentRecords` — two raw tags belonging to
  // one person now render as ONE row. `OpponentTable` itself is
  // presentational (no query/router hook), so the row build + sort +
  // destination-builder all live here.
  const opponentEvidenceRows = fighter
    ? buildOpponentEvidence({ matches: fighterMatches, aliasMap: aliasMap ?? {}, refreshedAt }).rows
    : [];
  const opponentTableRows: OpponentTableRow[] = [...opponentEvidenceRows]
    .sort((a, b) => b.total - a.total)
    .map((row) => ({
      key: row.identity,
      displayLabel: row.displayTag,
      wins: row.wins,
      losses: row.losses,
      total: row.total,
      winRate: row.winRate,
    }));

  function opponentHubHref(row: OpponentTableRow): string | undefined {
    if (!fighter) return undefined;
    const search = buildDrillDownSearch({ fighterId: fighter.id }).toString();
    return subjectPath(`${buildOpponentHubPath(row.key)}${search ? `?${search}` : ''}`);
  }

  const sortedFighterMatches = sortMatchesNewestFirst(fighterMatches);
  const terminusAxes: DrillDownAxes = {
    fighterId: fighter?.id,
    stageId: axesFromUrl.stageId,
    eventKey: axesFromUrl.eventKey,
    from: axesFromUrl.from,
    to: axesFromUrl.to,
  };

  const filterRow = (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-6 pt-6">
        <div className="flex flex-1 flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('fighterAnalysis.title')}</h1>
          <SelectFighter
            fighter={fighter}
            fighterSprites={orderedFighterSprites}
            fighterUsageById={fighterUsageById}
            onChange={setFighter}
          />
        </div>
        <HorizonSwitch />
      </CardContent>
    </Card>
  );

  return (
    <PageShell filterRow={filterRow}>
      {usingInferredFighters && <ChooseFavoritesPrompt />}
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      {fighter && (
        <PageGrid>
          {/* DD-07: the hero leads at every width — first in DOM order,
              never reordered by a responsive class. */}
          <GridCell span={8}>
            <FighterHero
              fighter={fighter}
              fighterMatches={fighterMatches}
              allMatches={allMatches}
              horizon={horizon}
              setHorizon={setHorizon}
              isLoading={horizonLoading || matchesLoading}
            />
          </GridCell>

          <GridCell span={4}>
            <FighterInsightRail
              fighterId={fighter.id}
              fighterMatches={fighterMatches}
              horizon={horizon}
            />
          </GridCell>

          {/* UI-SPEC §8.1: the 2-up "vs characters" / "vs players" list pair, stacking below 860px (container). */}
          <GridCell span={12}>
            <div className="@container grid grid-cols-1 gap-4 @[860px]:grid-cols-2">
              <VsCharactersList fighterId={fighter.id} fighterMatches={fighterMatches} />
              <VsPlayersList
                fighterId={fighter.id}
                fighterMatches={fighterMatches}
                aliasMap={aliasMap ?? {}}
              />
            </div>
          </GridCell>

          {/* The existing cards, in their current order, placed by content class rather than what space is left over. No card root here carries a stretch utility (UIX-04). */}
          <GridCell span={12} stack>
            <StageMastery
              fighterMatches={fighterMatches}
              stageHref={(stageId) => subjectPath(`/stages/${stageId}`)}
            />

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <MatchupCoverage allFilteredMatches={matches} fighterMatches={fighterMatches} />
              </div>
              <PracticeRecommendations
                allFilteredMatches={matches}
                fighterMatches={fighterMatches}
              />
            </div>

            <MatchupStageGuide fighterMatches={fighterMatches} />

            <OpponentTable rows={opponentTableRows} hubHref={opponentHubHref} />
          </GridCell>

          {hasDrillAxis && (
            <GridCell span={12}>
              <Card id={GAMES_ANCHOR_ID} className="scroll-mt-16">
                <CardHeader>
                  <CardTitle>{t('matchups.results')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <FilteredMatchList
                    matches={sortedFighterMatches}
                    axes={terminusAxes}
                    showDelete
                  />
                </CardContent>
              </Card>
            </GridCell>
          )}
        </PageGrid>
      )}
    </PageShell>
  );
}
