import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useProfile } from '@/hooks/useProfile';
import { useOnboardingProgress } from '@/hooks/useOnboardingProgress';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import type { OnboardingOriginKind } from '@/lib/onboardingOrigin';
import { ManualEventAssociation } from '@/pages/Tournaments/components/ManualEventAssociation';

interface GuidedStepConfig {
  key: string;
  done: boolean;
  titleKey: string;
  descriptionKey: string;
  buttonLabelKey: string;
  href: string;
}

/**
 * 13-CONTEXT.md D-04's "each intent lands on the REAL feature page" list —
 * `coach_clients` deliberately lands on `/coach` (Client Hub), never a
 * separate "coach welcome" surface.
 */
const ARTIFACT_LABEL_KEY: Record<OnboardingOriginKind, string> = {
  vodShare: 'onboarding.originChip.artifact.vodShare',
  recap: 'onboarding.originChip.artifact.recap',
  coachReview: 'onboarding.originChip.artifact.coachReview',
};

/**
 * Builds the per-intent checklist row config (D-04). Every `done` boolean
 * traces to a server read — NEVER a local `matches`/`vodTimestamps`/
 * `tournamentEntries` count:
 *
 * - `review_vod`/`track_improvement`/`prepare`/`scout` share ONE boolean
 *   per intent (`useOnboardingProgress`'s `vod`/`analytics`/
 *   `tournamentPrep`/`scout`) — the SAME `eventDedup` marker the matching
 *   activation D event writes server-side. There is no server-observable
 *   sub-signal for "attached a VOD but hasn't added two notes yet" (the
 *   activation engine only tracks the joint "vodUrl + >=2 notes" condition,
 *   `apps/api/src/onboarding/activation.ts`), so every row for these four
 *   intents shares that single done-state and the card is either "on step
 *   1" or fully collapsed — never a fabricated partial count.
 * - `coach_clients` uses two independently real server signals instead:
 *   `profile.coachingModeEnabled` (always true by the time this renders —
 *   D-06 enables it before `/welcome` ever navigates here) and
 *   `coachingClients.length > 0` (an existence check of the coach's OWN
 *   `GET /api/coaching/clients` read, not a matches/notes/tournament
 *   count). The third mockup row ("publish your first review") is
 *   deliberately NOT included here — no cheap existing signal answers "has
 *   ANY client received a published review" without an N+1 fetch across
 *   every client; that habit-forming nudge lives on `ClientOverviewPage`'s
 *   own per-client checklist (D-08, a later plan), not this app-wide card.
 */
function buildSteps(
  intent: OnboardingIntent,
  progress:
    { analytics: boolean; vod: boolean; tournamentPrep: boolean; scout: boolean } | undefined,
  coachingModeEnabled: boolean,
  coachingClientCount: number,
): GuidedStepConfig[] {
  switch (intent) {
    case 'review_vod': {
      const done = progress?.vod ?? false;
      return ['addVod', 'addTwoNotes', 'tagMatch'].map((key) => ({
        key,
        done,
        titleKey: `onboarding.guided.steps.reviewVod.${key}.title`,
        descriptionKey: `onboarding.guided.steps.reviewVod.${key}.description`,
        buttonLabelKey: `onboarding.guided.steps.reviewVod.${key}.button`,
        href: '/vod',
      }));
    }
    case 'track_improvement': {
      const done = progress?.analytics ?? false;
      return [
        { key: 'connectSync', href: '/settings/integrations' },
        { key: 'logGames', href: '/match-data' },
        { key: 'viewTrends', href: '/trends' },
      ].map(({ key, href }) => ({
        key,
        done,
        titleKey: `onboarding.guided.steps.trackImprovement.${key}.title`,
        descriptionKey: `onboarding.guided.steps.trackImprovement.${key}.description`,
        buttonLabelKey: `onboarding.guided.steps.trackImprovement.${key}.button`,
        href,
      }));
    }
    case 'prepare': {
      const done = progress?.tournamentPrep ?? false;
      return [
        { key: 'linkEvent', href: '/tournaments' },
        { key: 'scoutOpponent', href: '/scout' },
        { key: 'reviewMatchups', href: '/matchups' },
      ].map(({ key, href }) => ({
        key,
        done,
        titleKey: `onboarding.guided.steps.prepare.${key}.title`,
        descriptionKey: `onboarding.guided.steps.prepare.${key}.description`,
        buttonLabelKey: `onboarding.guided.steps.prepare.${key}.button`,
        href,
      }));
    }
    case 'scout': {
      const done = progress?.scout ?? false;
      return [
        { key: 'runScout', href: '/scout' },
        { key: 'reviewReport', href: '/reports' },
      ].map(({ key, href }) => ({
        key,
        done,
        titleKey: `onboarding.guided.steps.scout.${key}.title`,
        descriptionKey: `onboarding.guided.steps.scout.${key}.description`,
        buttonLabelKey: `onboarding.guided.steps.scout.${key}.button`,
        href,
      }));
    }
    case 'coach_clients': {
      return [
        {
          key: 'enableCoaching',
          done: coachingModeEnabled,
          titleKey: 'onboarding.guided.steps.coachClients.enableCoaching.title',
          descriptionKey: 'onboarding.guided.steps.coachClients.enableCoaching.description',
          buttonLabelKey: 'onboarding.guided.steps.coachClients.enableCoaching.button',
          href: '/coach',
        },
        {
          key: 'createClient',
          done: coachingClientCount > 0,
          titleKey: 'onboarding.guided.steps.coachClients.createClient.title',
          descriptionKey: 'onboarding.guided.steps.coachClients.createClient.description',
          buttonLabelKey: 'onboarding.guided.steps.coachClients.createClient.button',
          href: '/coach',
        },
      ];
    }
  }
}

/**
 * The pinned guided-path checklist card (ONBD-03, D-04) — mounted app-wide
 * in `MainLayout` so it follows the signed-in user onto the real feature
 * page for their saved intent. Self-guards: renders nothing when there is
 * no saved intent, progress hasn't loaded yet, or every step for the intent
 * is already done (D-04: "the dashboard next-best-action area mirrors the
 * current step so leaving the path doesn't lose it" — once done, there is
 * nothing left to pin).
 *
 * Clones `ClientOverviewPage`'s checklist visual pattern (numbered circle /
 * checkmark, ONE accented button on the first incomplete row) — see
 * `buildSteps` above for exactly which server signal backs each intent's
 * done-state.
 */
export function GuidedPathCard() {
  const { t } = useTranslation();
  const location = useLocation();
  const [showManualPrep, setShowManualPrep] = useState(false);
  const { data: profile } = useProfile();
  const { data: progress } = useOnboardingProgress();
  const intent = profile?.onboardingIntent ?? null;
  const { data: coachingClients } = useCoachingClients({ enabled: intent === 'coach_clients' });

  // Phase 13 (ONBD-03, D-01): `/dashboard` gets its OWN, lighter-weight
  // next-best-action mirror (`DashboardPage.tsx`) — the density rule ("ONE
  // next-best-action area, never onboarding chrome elsewhere") means the
  // full pinned card stays off the dashboard specifically, appearing only
  // on the real feature pages it's meant to follow the user onto.
  if (!intent || location.pathname === '/dashboard') {
    return null;
  }

  const steps = buildSteps(
    intent,
    progress,
    profile?.coachingModeEnabled ?? false,
    coachingClients?.length ?? 0,
  );

  const firstIncompleteIndex = steps.findIndex((step) => !step.done);
  const allStepsDone = firstIncompleteIndex === -1;

  if (allStepsDone) {
    return null;
  }

  const origin = onboardingOrigin.read();
  const hasSafeOrigin = origin != null && onboardingOrigin.isSafeReturnPath(origin.returnPath);

  return (
    <Card className="mb-4 border-primary/20" data-testid="guided-path-card">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">{t(`onboarding.intent.${intent}.title`)}</p>
          <span className="text-xs text-muted-foreground">
            {t('onboarding.guided.progress', {
              current: firstIncompleteIndex + 1,
              total: steps.length,
            })}
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border">
          {steps.map((step, index) => (
            <div
              key={step.key}
              data-testid={`guided-step-${step.key}`}
              data-done={step.done}
              className={cn('flex items-center gap-3 px-3 py-2.5', index > 0 && 'border-t')}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                  step.done ? 'border-emerald-500 text-emerald-500' : 'text-muted-foreground',
                )}
              >
                {step.done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <div className="flex-1">
                <p className="text-sm font-medium">{t(step.titleKey)}</p>
                <p className="text-xs text-muted-foreground">{t(step.descriptionKey)}</p>
              </div>
              {index === firstIncompleteIndex && (
                <Button
                  asChild
                  size="sm"
                  className={
                    intent === 'coach_clients'
                      ? 'bg-coaching-accent text-coaching-accent-foreground hover:bg-coaching-accent/90'
                      : undefined
                  }
                >
                  <Link to={step.href}>{t(step.buttonLabelKey)}</Link>
                </Button>
              )}
            </div>
          ))}
        </div>

        {intent === 'prepare' &&
          (showManualPrep ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium">
                {t('onboarding.recovery.eventAssociationFailed.title')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('onboarding.recovery.eventAssociationFailed.description')}
              </p>
              <ManualEventAssociation onSuccess={() => setShowManualPrep(false)} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowManualPrep(true)}
              className="w-fit text-left text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              {t('onboarding.recovery.eventAssociationFailed.button')}
            </button>
          ))}

        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs">
          {hasSafeOrigin && origin ? (
            <Link
              to={origin.returnPath}
              className="text-muted-foreground hover:text-foreground"
              data-testid="guided-origin-chip"
            >
              {t('onboarding.originChip.fromArtifact', {
                artifact: t(ARTIFACT_LABEL_KEY[origin.kind]),
              })}
            </Link>
          ) : (
            <span />
          )}
          <Link
            to="/welcome"
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t('onboarding.guided.switchIntent')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
