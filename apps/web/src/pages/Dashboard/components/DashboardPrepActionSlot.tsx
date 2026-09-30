import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useProfile } from '@/hooks/useProfile';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';
import { usePrepBrief } from '@/hooks/usePrepBrief';
import {
  findMostRecentPastEntry,
  findNearestUpcomingEntry,
  formatEntryDate,
  isDebriefWindowOpen,
} from '@/lib/prepEntryPoints';
import { PrepManualEntryDialog } from '@/pages/Tournaments/components/PrepManualEntryDialog';

/**
 * Phase 26 (PREP-01, D-01/D-04/D-16): the dashboard's ONE prep action slot,
 * mounted independently of `DashboardNextBestAction` — that slot's
 * contract is onboarding progression, unrelated to ongoing tournament
 * prep, and is untouched by this component.
 *
 * Plan 39-12 (PREP-05, D-10): the exported symbol is a THIN GATE.
 * D-10: prep and debrief entry points exist for the OWN-ACCOUNT subject only — this renders nothing under `/coach/:clientId/*` and `/workspace/:tenantId/*` (the dashboard IS subject-mounted).
 * `react-hooks/rules-of-hooks` is why this is a separate component and not a guard clause: every other hook lives in `OwnAccountPrepActionSlot`, so each stays unconditional.
 * The two subject hooks are composed directly (not through the collapsing
 * helper); under a coach or workspace route the inner slot never mounts, so
 * no tournament, profile or prep request is issued at all.
 */
export function DashboardPrepActionSlot({
  suppressReviewForEntryKey = null,
}: {
  /**
   * Plan 39.2-13 (DD-07): the entry key of the recap card currently on screen. The recap
   * carries its own door into this event, so the review state yields for that one entry and
   * the slot falls through to its next state. Null (no recap, or a dismissed one) changes nothing.
   */
  suppressReviewForEntryKey?: string | null;
}) {
  const { clientId } = useActiveSubject();
  const { tenantId } = useOwnedWorkspaceSubject();
  if (clientId || tenantId) {
    return null;
  }
  return <OwnAccountPrepActionSlot suppressReviewForEntryKey={suppressReviewForEntryKey} />;
}

/**
 * Four mutually exclusive states, in this precedence order (one if-chain,
 * no fallthrough render):
 *
 * 1. upcoming — a nearest future-dated registry entry exists: the
 *    upcoming-event title + a link into its prep brief.
 * 2. review (plan 39-12, D-13) — no upcoming entry, AND the most recent
 *    past entry (admin-imported rows skipped before any date is read,
 *    review C1-H7) has a SERVER brief status inside the fourteen-day
 *    debrief window (`isDebriefWindowOpen`: activated, `reviewAt` present
 *    and passed, at most fourteen days ago). Review mode is the server's
 *    answer, never an entry-date comparison (28-CONTEXT.md "⚠ ONE
 *    CORRECTION"), and the window composes the destination's own
 *    `derivePrepSurfaceMode`, so the link always lands in review mode.
 *    Review sits BEFORE add-event (review C1-M6): a user carrying the
 *    `prepare` intent must still see the review door.
 * 3. addEvent — no upcoming entry AND the profile's saved
 *    `onboardingIntent` is exactly `'prepare'`: the add-event recovery
 *    path, opening `PrepManualEntryDialog`.
 * 4. nothing — anything else (including a null intent). This branch
 *    deliberately renders nothing, to preserve the existing dashboard
 *    exactly as it was; recovery chrome only appears where preparation is
 *    contextually relevant (D-16).
 */
function OwnAccountPrepActionSlot({
  suppressReviewForEntryKey,
}: {
  suppressReviewForEntryKey: string | null;
}) {
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

  // The review candidate is only looked up when no upcoming entry exists
  // (upcoming wins), so the common case issues no extra read.
  const reviewCandidate = useMemo(() => {
    if (!entries || nearestEntry) {
      return null;
    }
    return findMostRecentPastEntry(entries, now);
  }, [entries, nearestEntry, now]);
  const reviewQuery = usePrepBrief(reviewCandidate?.entry.entryKey);

  // 260725-juj: a pending or failed registry/profile query is UNKNOWN, not
  // "no upcoming event" — render nothing until both queries resolve rather
  // than guessing at the wrong state.
  if (entriesPending || entriesError || profilePending || profileError) {
    return null;
  }

  if (nearestEntry) {
    return (
      <Card
        className="border-dashed"
        data-testid="dashboard-prep-action-slot"
        data-state="upcoming"
      >
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

  // Code review WEB-01: a PENDING review-status read is unknown — render
  // nothing rather than an add-event door the settled render would retract
  // (the same rule as the registry/profile reads above). An ERRORED read
  // still falls through to the next state, so a failing endpoint never hides
  // the slot for good.
  if (reviewCandidate && reviewQuery.isPending) {
    return null;
  }

  if (
    reviewCandidate &&
    reviewCandidate.entry.entryKey !== suppressReviewForEntryKey &&
    reviewQuery.isSuccess &&
    isDebriefWindowOpen(reviewQuery.data, now)
  ) {
    return (
      <Card className="border-dashed" data-testid="dashboard-prep-action-slot" data-state="review">
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm font-medium break-words">
            {t('prep.dashboard.review.title', {
              eventName: reviewCandidate.entry.eventName,
              date: formatEntryDate(reviewCandidate.endMs, i18n.language),
            })}
          </p>
          <Button asChild size="sm">
            <Link to={`/tournaments/${reviewCandidate.entry.entryKey}/prep`}>
              {t('prep.dashboard.review.cta')}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (profile?.onboardingIntent === 'prepare') {
    return (
      <>
        <Card
          className="border-dashed"
          data-testid="dashboard-prep-action-slot"
          data-state="addEvent"
        >
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
