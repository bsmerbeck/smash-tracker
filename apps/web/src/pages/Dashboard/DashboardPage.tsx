import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Fighter, OnboardingIntent } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useFighters } from '@/hooks/useFighters';
import { useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useSortedFighters } from '@/hooks/useFighterName';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useProfile } from '@/hooks/useProfile';
import { useOnboardingProgress } from '@/hooks/useOnboardingProgress';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { intentDestination } from '@/hooks/useOnboarding';
import { getFighterById } from '@/data/sprites';
import { DemoAccountBanner } from '@/components/DemoAccountBanner';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { DashboardContext, type DashboardContextValue } from './DashboardContext';
import { DashboardToolbar } from './components/DashboardToolbar';
import { WinLossTracker } from './components/WinLossTracker';
import { MatchupSnapshot } from './components/MatchupSnapshot';
import { PreviousMatches } from './components/PreviousMatches';
import { LastMatchesChart } from './components/LastMatchesChart';
import { HeroStats } from './components/HeroStats';
import { StageTiles } from './components/StageTiles';
import { DashboardPrepActionSlot } from './components/DashboardPrepActionSlot';
import { SelfDataCoveragePanel } from '@/pages/Coaching/components/SelfDataCoveragePanel';

type NextBestAction =
  | { kind: 'chooseIntent' }
  | { kind: 'createFirstClient' }
  | { kind: 'currentStep'; intent: OnboardingIntent };

/**
 * Phase 13 (ONBD-03, D-01/D-04/D-08): the dashboard's ONE next-best-action
 * area — the density rule locked in 13-CONTEXT.md ("dashboard gets ONE
 * next-best-action area, never onboarding chrome elsewhere") means this is
 * the single place onboarding state surfaces on `/dashboard`;
 * `GuidedPathCard` itself deliberately stays off this route (see its own
 * doc comment). Exactly one of three mutually-exclusive states, never more
 * than one shown at once:
 *
 * - No saved intent: the compact "choose what you're here to do" re-entry
 *   into `/welcome` (D-01's skippable-chooser re-entry point).
 * - `coach_clients` saved but no client created yet: "create your first
 *   client" (D-08's coach-path mirror).
 * - Any other saved intent, not yet complete: mirrors the current guided
 *   step so leaving the path never loses it (D-04). Complete (or a
 *   `coach_clients` intent that already has a client) renders nothing.
 */
function useDashboardNextBestAction(): NextBestAction | null {
  const { data: profile } = useProfile();
  const { data: progress } = useOnboardingProgress();
  const intent = profile?.onboardingIntent ?? null;
  const coachingClientsQuery = useCoachingClients({ enabled: intent === 'coach_clients' });

  if (!intent) {
    return { kind: 'chooseIntent' };
  }
  if (intent === 'coach_clients') {
    // 260725-juj: a pending or failed clients query is UNKNOWN, not zero —
    // showing no next-best-action here is correct until the real count is
    // known, rather than resurrecting "create your first client" on top of
    // a coach who may already have clients.
    if (coachingClientsQuery.isPending || coachingClientsQuery.isError) {
      return null;
    }
    return (coachingClientsQuery.data?.length ?? 0) > 0 ? null : { kind: 'createFirstClient' };
  }
  const doneByIntent: Record<Exclude<OnboardingIntent, 'coach_clients'>, boolean | undefined> = {
    review_vod: progress?.vod,
    track_improvement: progress?.analytics,
    prepare: progress?.tournamentPrep,
    scout: progress?.scout,
  };
  if (doneByIntent[intent]) {
    return null;
  }
  return { kind: 'currentStep', intent };
}

function DashboardNextBestAction() {
  const { t } = useTranslation();
  const action = useDashboardNextBestAction();

  if (!action) {
    return null;
  }

  if (action.kind === 'chooseIntent') {
    return (
      <Card className="border-dashed" data-testid="dashboard-next-best-action">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {t('onboarding.dashboard.nextBestAction.chooseIntent.title')}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/welcome">
              {t('onboarding.dashboard.nextBestAction.chooseIntent.button')}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (action.kind === 'createFirstClient') {
    return (
      <Card data-testid="dashboard-next-best-action">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {t('onboarding.dashboard.nextBestAction.createFirstClient.title')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('onboarding.dashboard.nextBestAction.createFirstClient.description')}
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/coach">
              {t('onboarding.dashboard.nextBestAction.createFirstClient.button')}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-dashed" data-testid="dashboard-next-best-action">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {t('onboarding.dashboard.nextBestAction.currentStep.title')}
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to={intentDestination(action.intent)}>
            {t(`onboarding.intent.${action.intent}.title`)}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Ports legacy/src/screens/Dashboard. */
export function DashboardPage() {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  const { data: fighterSelection, isLoading: fightersLoading } = useFighters();
  const {
    matches,
    allMatches,
    timeFilteredMatches,
    isLoading: matchesLoading,
    filterActive,
  } = useFilteredMatches();

  const rawFighterSprites = useMemo<Fighter[]>(() => {
    const ids = [...(fighterSelection?.primary ?? []), ...(fighterSelection?.secondary ?? [])];
    return ids
      .map((id) => getFighterById(id))
      .filter((sprite): sprite is Fighter => sprite != null);
  }, [fighterSelection]);
  // 260725-Q1: alphabetized by localized name, not primary+secondary save
  // order — matches every other fighter picker in the app.
  const fighterSprites = useSortedFighters(rawFighterSprites);

  // Tracks an explicit user selection only; when unset, the first available
  // fighter is used (derived below during render, mirroring legacy's
  // one-time "firstLoad" hydration of `fighter` from the first sprite,
  // without needing an effect to seed state from data that just loaded).
  const [selectedFighterId, setSelectedFighterId] = useState<number | undefined>(undefined);

  const fighter =
    fighterSprites.find((s) => s.id === selectedFighterId) ?? fighterSprites[0] ?? undefined;

  const contextValue: DashboardContextValue = {
    fighterSprites,
    fighter,
    setFighter: (next) => setSelectedFighterId(next.id),
  };

  if (fightersLoading || matchesLoading) {
    return (
      <div className="flex flex-col gap-6">
        <DemoAccountBanner />
        <div className="text-muted-foreground">{t('dashboard.loading')}</div>
      </div>
    );
  }

  // Phase 30.1 Plan 05 (WKSP-01A, review C2-H2): `<SelfDataCoveragePanel />`
  // is hoisted ABOVE the `fighterSprites.length === 0` gate so it renders
  // in BOTH the no-fighters early-return branch below AND the normal
  // content tree — a fresh, fighterless demo account (Plan 01 asserts
  // empty primary/secondary fighter selections for every fresh account)
  // ALWAYS hits the no-fighters branch and would otherwise never see its
  // migrated completeness report. It self-hides (renders nothing) when the
  // account has no migrated coverage, so this is safe for every ordinary
  // fighterless account too.
  if (fighterSprites.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <DemoAccountBanner />
        <SelfDataCoveragePanel />
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

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="flex flex-col gap-6">
        <DemoAccountBanner />
        <SelfDataCoveragePanel />
        <DashboardNextBestAction />
        <DashboardPrepActionSlot />
        <HeroStats matches={matches} timeFilteredMatches={timeFilteredMatches} />

        <DashboardToolbar />
        {filterActive && allMatches.length > 0 && matches.length === 0 && <FilteredEmptyNotice />}
        <WinLossTracker matches={matches} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LastMatchesChart matches={matches} />
          <PreviousMatches matches={matches} />
        </div>

        <StageTiles matches={matches} />
        <MatchupSnapshot matches={matches} />
      </div>
    </DashboardContext.Provider>
  );
}
