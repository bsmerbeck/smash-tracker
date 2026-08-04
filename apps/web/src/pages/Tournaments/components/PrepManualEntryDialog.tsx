import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { tournamentEntriesQueryKey } from '@/hooks/useTournamentEntries';
import { onboardingProgressQueryKey } from '@/hooks/useOnboardingProgress';
import { useActivatePrepBrief } from '@/hooks/usePrepBrief';

/**
 * Parses a raw `<input type="date">` value (`YYYY-MM-DD`) as LOCAL calendar
 * midnight, returning its epoch-ms value, or `null` for a malformed value.
 *
 * D-05, hard requirement: `new Date('YYYY-MM-DD')` parses the string as
 * UTC midnight per the ECMA-262 date-time string grammar, so a player west
 * of UTC (e.g. US Pacific, UTC-8) sees their typed calendar day rendered
 * back as the PRECEDING day once converted to local time. Splitting the
 * string and constructing the Date from (year, month-1, day) instead lands
 * the Date object at LOCAL midnight of the exact calendar day the player
 * typed, eliminating that off-by-one-day class of bug. Exported so a test
 * can pin the behavior with a fixed value rather than the live clock.
 */
export function parseLocalCalendarDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  // Guards impossible calendar dates (e.g. 2024-02-30) that the Date
  // constructor would otherwise silently roll forward into the next month.
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed.getTime();
}

export interface PrepManualEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The dashboard action slot's "not a dead end" recovery path (D-04, PREP-01):
 * a future-date-required variant of `ManualEventAssociation`'s two-field
 * form, presented as a modal (UI-SPEC: "Dialog, not a page") because the
 * locked create → activate → navigate sequence is one continuous
 * interaction the player should never leave before landing on the brief.
 *
 * Unlike the base manual-entry form (optional date, server defaults to
 * now), the date here is REQUIRED and must be strictly in the future —
 * a client-side variant rule for this flow only (D-04); `POST
 * /api/tournaments/manual-entry` itself is unchanged for every other
 * caller.
 */
export function PrepManualEntryDialog({ open, onOpenChange }: PrepManualEntryDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventEndDate, setEventEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Set once manual-entry succeeds, so `useActivatePrepBrief` below re-binds
  // to the concrete server-derived entryKey before the effect fires.
  const [activatingEntryKey, setActivatingEntryKey] = useState<string | null>(null);

  const activateBrief = useActivatePrepBrief(activatingEntryKey ?? '');
  // A bare `Date.now()` call in the render body is impure (React Compiler
  // forbids it); a lazy `useState` initializer is the sanctioned one-time
  // read (mirrors `ClaimStatusBadge`'s house pattern). A stale "now" across
  // re-renders is harmless for a form filled out over seconds/minutes.
  const [now] = useState(() => Date.now());

  function resetFields() {
    setEventName('');
    setEventDate('');
    setEventEndDate('');
    setError(null);
    setActivatingEntryKey(null);
  }

  // Every close path (Radix-internal Escape/overlay/X, or this component's
  // own success->navigate flow below) funnels through here. WR-02 residual:
  // deliberately does NOT clear `activatingEntryKey` — a failed activation
  // means the tournamentEntries row already exists server-side, and clearing
  // the only state that makes `handleSubmit` retry (instead of re-running
  // `manualEntry.mutate()`) would orphan that row and mint a duplicate entry
  // the next time this dialog is reopened and submitted. The name/date/error
  // fields still reset on close; the retry path in `handleSubmit` works
  // without them (it checks `activatingEntryKey` before `canSubmit`).
  function handleOpenChange(next: boolean) {
    if (!next) {
      setEventName('');
      setEventDate('');
      setEventEndDate('');
      setError(null);
    }
    onOpenChange(next);
  }

  const parsedDate = parseLocalCalendarDate(eventDate);
  const isFutureDate = parsedDate !== null && parsedDate > now;
  const showDateError = eventDate.trim().length > 0 && !isFutureDate;
  const parsedEndDate = parseLocalCalendarDate(eventEndDate);
  // The end date needs only end >= start (the start date already keeps its
  // own strictly-future rule above) — matches the shared schema's refine.
  const isEndDateValid =
    parsedEndDate === null || (parsedDate !== null && parsedEndDate >= parsedDate);
  const showEndDateError = eventEndDate.trim().length > 0 && !isEndDateValid;
  const trimmedName = eventName.trim();
  const canSubmit = trimmedName.length > 0 && isFutureDate && isEndDateValid;

  const manualEntry = useMutation({
    mutationFn: () =>
      api.tournaments.manualEntry({
        eventName: trimmedName,
        eventDate: parsedDate ?? undefined,
        ...(parsedEndDate !== null ? { eventEndDate: parsedEndDate } : {}),
      }),
    onSuccess: async (entry) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tournamentEntriesQueryKey }),
        queryClient.invalidateQueries({ queryKey: onboardingProgressQueryKey }),
      ]);
      if (!entry.entryKey) {
        setError(t('prep.error.addEventFailed'));
        return;
      }
      setError(null);
      setActivatingEntryKey(entry.entryKey);
    },
    onError: () => {
      setError(t('prep.error.addEventFailed'));
    },
  });

  // Activation is triggered by this click flow rather than the destination
  // page's mount (D-04, the one place in this phase that's true). Runs once
  // `activatingEntryKey` is set above, by which point `activateBrief` has
  // already re-rendered bound to the concrete entryKey. Activation is
  // idempotent server-side, so the destination page's own mount-time read
  // safely records a reopen instead of re-activating.
  //
  // WR-03: extracted so a failed activation can be RETRIED on this same
  // entryKey (via handleSubmit below) without re-running manualEntry.mutate()
  // — re-running the create call would mint a second, distinct tournament
  // entry via deriveManualEntryKey's fresh random suffix and orphan the
  // first, already-created one.
  function triggerActivation(entryKey: string) {
    activateBrief.mutate(undefined, {
      onSuccess: () => {
        resetFields();
        onOpenChange(false);
        navigate(`/tournaments/${entryKey}/prep`);
      },
      onError: () => {
        setError(t('prep.error.addEventFailed'));
      },
    });
  }

  useEffect(() => {
    if (!activatingEntryKey) {
      return;
    }
    triggerActivation(activatingEntryKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activatingEntryKey]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (manualEntry.isPending || activateBrief.isPending) {
      return;
    }
    // WR-03: a previous activation attempt failed after the tournament entry
    // was already created — retry activation on that SAME entryKey rather
    // than calling manualEntry.mutate() again.
    if (activatingEntryKey) {
      setError(null);
      triggerActivation(activatingEntryKey);
      return;
    }
    if (!canSubmit) {
      return;
    }
    manualEntry.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('prep.manualEntry.title')}</DialogTitle>
          <DialogDescription>{t('prep.manualEntry.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex flex-col gap-1">
            <Label htmlFor="prep-manual-entry-name">{t('prep.manualEntry.nameLabel')}</Label>
            <Input
              id="prep-manual-entry-name"
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="prep-manual-entry-date">{t('prep.manualEntry.dateLabel')}</Label>
            <Input
              id="prep-manual-entry-date"
              type="date"
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
              required
            />
            {showDateError && (
              <p className="text-xs text-destructive">{t('prep.manualEntry.dateRequired')}</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="prep-manual-entry-end-date">{t('prep.manualEntry.endDateLabel')}</Label>
            <Input
              id="prep-manual-entry-end-date"
              type="date"
              value={eventEndDate}
              onChange={(event) => setEventEndDate(event.target.value)}
            />
            {showEndDateError ? (
              <p className="text-xs text-destructive">{t('prep.manualEntry.endBeforeStart')}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('prep.manualEntry.endDateHint')}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                (!canSubmit && !activatingEntryKey) ||
                manualEntry.isPending ||
                activateBrief.isPending
              }
            >
              {t('prep.manualEntry.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
