import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { tournamentEntriesQueryKey } from '@/hooks/useTournamentEntries';
import { onboardingProgressQueryKey } from '@/hooks/useOnboardingProgress';

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
  const [error, setError] = useState<string | null>(null);

  const manualEntry = useMutation({
    mutationFn: () =>
      api.tournaments.manualEntry({
        eventName: eventName.trim(),
        eventDate: eventDate ? new Date(eventDate).getTime() : undefined,
      }),
    onSuccess: async () => {
      setEventName('');
      setEventDate('');
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
    if (!trimmed) {
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
      <Button
        type="submit"
        size="sm"
        disabled={manualEntry.isPending || eventName.trim().length === 0}
      >
        {t('onboarding.prep.manualAssociate.submit')}
      </Button>
    </form>
  );
}
