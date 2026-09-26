import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useProfile } from '@/hooks/useProfile';
import { findNearestUpcomingEntry, formatEntryDate } from '@/lib/prepEntryPoints';
import { PrepManualEntryDialog } from '@/pages/Tournaments/components/PrepManualEntryDialog';

/**
 * Phase 26 (PREP-01, D-01/D-04/D-16): the dashboard's ONE prep action slot,
 * mounted independently of `DashboardNextBestAction` — that slot's
 * contract is onboarding progression, unrelated to ongoing tournament
 * prep, and is untouched by this component. Exactly two mutually
 * exclusive states, or nothing:
 *
 * 1. A nearest future-dated registry entry exists: the upcoming-event
 *    title + a link into its prep brief.
 * 2. No future-dated entry AND the profile's saved `onboardingIntent` is
 *    exactly `'prepare'`: the add-event recovery path, opening
 *    `PrepManualEntryDialog`.
 * 3. Anything else (including a null intent): renders nothing — this
 *    branch deliberately does so, to preserve the existing dashboard
 *    exactly as it was. Recovery chrome only appears where preparation
 *    is contextually relevant (D-16); a third "always show something"
 *    state would violate the locked two-state contract.
 */
export function DashboardPrepActionSlot() {
  const { t, i18n } = useTranslation();
  const {
    data: entries,
    isPending: entriesPending,
    isError: entriesError,
  } = useTournamentEntries();
  const { data: profile, isPending: profilePending, isError: profileError } = useProfile();
  const [dialogOpen, setDialogOpen] = useState(false);
  // A bare `Date.now()` call in the render body is impure (React Compiler
  // forbids it); a lazy `useState` initializer is the sanctioned one-time
  // read, mirroring `ClaimStatusBadge`'s established house pattern. A
  // stale "now" across re-renders is harmless — this only needs to be
  // right as of the render that computed it.
  const [now] = useState(() => Date.now());

  const nearestEntry = useMemo(() => {
    if (!entries) {
      return null;
    }
    return findNearestUpcomingEntry(entries, now);
  }, [entries, now]);

  // 260725-juj: a pending or failed registry/profile query is UNKNOWN, not
  // "no upcoming event" — render nothing until both queries resolve rather
  // than guessing at the wrong state.
  if (entriesPending || entriesError || profilePending || profileError) {
    return null;
  }

  if (nearestEntry) {
    return (
      <Card className="border-dashed" data-testid="dashboard-prep-action-slot">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {t('prep.dashboard.upcoming.title', {
              eventName: nearestEntry.eventName,
              date: formatEntryDate(nearestEntry.firstSetAt, i18n.language),
            })}
          </p>
          <Button asChild size="sm">
            <Link to={`/tournaments/${nearestEntry.entryKey}/prep`}>
              {t('prep.dashboard.upcoming.cta')}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (profile?.onboardingIntent === 'prepare') {
    return (
      <>
        <Card className="border-dashed" data-testid="dashboard-prep-action-slot">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">{t('prep.dashboard.addEvent.title')}</p>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              {t('prep.dashboard.addEvent.cta')}
            </Button>
          </CardContent>
        </Card>
        <PrepManualEntryDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  return null;
}
