import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { tournamentEntriesQueryKey } from '@/hooks/useTournamentEntries';
import { onboardingProgressQueryKey } from '@/hooks/useOnboardingProgress';
import { parseLocalCalendarDate } from './PrepManualEntryDialog';

/**
 * Phase 13 (ONBD-04, D-05): the prep-path integration-failure recovery — a
 * minimal event-name (+ optional date) form that POSTs
 * `/api/tournaments/manual-entry` (13-05), reaching the SAME
 * server-verified `tournament_prep_activated` outcome a start.gg/parry.gg
 * sync would. Mounted inline by `GuidedPathCard`'s `prepare`-path step so
 * the fallback lives on the SAME SCREEN as the pinned guided card, never a
 * separate page — the checklist never dead-ends (D-05).
 *
 * Invalidates `tournamentEntriesQueryKey` (the `/tournaments` list) and
 * `onboardingProgressQueryKey` (the guided card's own done-state) on
 * success so both refetch without a manual reload.
 */
export function ManualEventAssociation({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventEndDate, setEventEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  // CR-03 (Phase 28 review): the start date MUST go through the same
  // parseLocalCalendarDate the end date uses — `new Date('YYYY-MM-DD')`
  // parses as UTC midnight (Phase 26 rule: never new Date('YYYY-MM-DD')),
  // so mixing bases made a same-day entry read `end < start` in every UTC+
  // timezone and 400 on the shared schema's refine.
  const parsedStartDate = parseLocalCalendarDate(eventDate);
  const parsedEndDate = parseLocalCalendarDate(eventEndDate);
  // End date without a start date is blocked client-side, matching the
  // shared schema's refine ("eventEndDate requires eventDate to be present").
  // End before start is blocked too — the same `end >= start` rule
  // PrepManualEntryDialog enforces, so the server's 400 is never the first
  // place the user learns about it.
  const endDateBlocked =
    (eventEndDate.trim().length > 0 && eventDate.trim().length === 0) ||
    (parsedEndDate !== null && parsedStartDate !== null && parsedEndDate < parsedStartDate);

  const manualEntry = useMutation({
    mutationFn: () =>
      api.tournaments.manualEntry({
        eventName: eventName.trim(),
        eventDate: parsedStartDate ?? undefined,
        ...(parsedEndDate !== null ? { eventEndDate: parsedEndDate } : {}),
      }),
    onSuccess: async () => {
      setEventName('');
      setEventDate('');
      setEventEndDate('');
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tournamentEntriesQueryKey }),
        queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey }),
      ]);
      onSuccess?.();
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : t('onboarding.welcome.error'));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = eventName.trim();
    if (!trimmed || endDateBlocked) {
      return;
    }
    manualEntry.mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-lg border border-dashed p-3"
      data-testid="manual-event-association-form"
    >
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-event-name" className="text-xs">
          {t('onboarding.prep.manualAssociate.label')}
        </Label>
        <Input
          id="manual-event-name"
          value={eventName}
          onChange={(event) => setEventName(event.target.value)}
          maxLength={200}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-event-date" className="text-xs">
          {t('onboarding.prep.manualAssociate.date')}
        </Label>
        <Input
          id="manual-event-date"
          type="date"
          value={eventDate}
          onChange={(event) => setEventDate(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-event-end-date" className="text-xs">
          {t('onboarding.prep.manualAssociate.endDate')}
        </Label>
        <Input
          id="manual-event-end-date"
          type="date"
          value={eventEndDate}
          onChange={(event) => setEventEndDate(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={manualEntry.isPending || eventName.trim().length === 0 || endDateBlocked}
      >
        {t('onboarding.prep.manualAssociate.submit')}
      </Button>
    </form>
  );
}
