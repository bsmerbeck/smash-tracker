import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import { MAX_DELIVERY_VODS } from '@smash-tracker/shared';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface DeliveryVodPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The client's VOD-bearing match library (`useMatches()` filtered by `vodUrl != null`) — every candidate VOD the coach can include (DLVX-04). */
  vods: Match[];
  /** Pre-checked matchIds the moment the dialog opens — the review's cited VODs or the session's linked VODs. */
  defaultSelectedMatchIds: string[];
  /** Fires with the confirmed matchId selection; the caller mints the delivery with it as `includedVods`. */
  onConfirm: (selectedMatchIds: string[]) => void;
  /** Whether the mint mutation `onConfirm` triggers is currently in flight. */
  isPending: boolean;
}

/**
 * Phase 21 Plan 03 (DLVX-04): the shared VOD-inclusion dialog inserted
 * BEFORE both mint flows (`ReviewsListPage`'s Deliver menu item,
 * `SessionComposerPage`'s Deliver button) — the owner's locked "coach picks
 * VODs per delivery, defaulting to review-cited / session-linked" decision.
 * Deliberately presentational: the caller resolves `vods` (via `useMatches()`)
 * and the default selection (cited citations / linked matchIds) so this
 * component stays a pure controlled dialog, easy to test in isolation.
 *
 * No checkbox UI primitive exists in this codebase — a toggle-row button
 * list (check indicator, `aria-pressed`) mirrors `ReviewSourcesDrawer.tsx`'s
 * own source-list pattern instead of hand-rolling a new primitive.
 */
export function DeliveryVodPicker({
  open,
  onOpenChange,
  vods,
  defaultSelectedMatchIds,
  onConfirm,
  isPending,
}: DeliveryVodPickerProps) {
  const { t, i18n } = useTranslation();
  const fighterName = useFighterNameResolver();

  const [selected, setSelected] = useState<string[]>(defaultSelectedMatchIds);
  // "Adjusting state when a prop changes" (React's own documented pattern,
  // already established in this codebase by `DeliveryVodNotesTab`'s
  // render-time `currentMatchId` seeding): re-seed the local selection ONLY
  // on the closed -> open transition, tracked via a previous-open snapshot —
  // never on every render, which would otherwise reset an in-progress
  // selection any time `defaultSelectedMatchIds` gets a fresh array identity
  // from the parent (e.g. an unrelated query refetch while the dialog is
  // still open).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(defaultSelectedMatchIds);
    }
  }

  const capReached = selected.length >= MAX_DELIVERY_VODS;

  function toggle(matchId: string) {
    setSelected((prev) => {
      if (prev.includes(matchId)) {
        return prev.filter((id) => id !== matchId);
      }
      if (prev.length >= MAX_DELIVERY_VODS) {
        return prev;
      }
      return [...prev, matchId];
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('coaching.deliveryVodPicker.title')}</DialogTitle>
          <DialogDescription>
            {t('coaching.deliveryVodPicker.description', { max: MAX_DELIVERY_VODS })}
          </DialogDescription>
        </DialogHeader>

        {vods.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('coaching.deliveryVodPicker.empty')}</p>
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {vods.map((match) => {
              const isSelected = selected.includes(match.id);
              const disabled = !isSelected && capReached;
              return (
                <button
                  key={match.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  onClick={() => toggle(match.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                    isSelected && 'border-primary bg-accent',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-sm border',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input',
                    )}
                  >
                    {isSelected && <Check className="size-3" />}
                  </span>
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {fighterName(match.fighter_id)} {t('matchups.vs')}{' '}
                      {fighterName(match.opponent_id)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(match.time).toLocaleDateString(i18n.language)}
                      {match.opponent ? ` · ${match.opponent}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t('coaching.deliveryVodPicker.selectedCount', { count: selected.length })}
        </p>
        {capReached && (
          <p className="text-xs text-muted-foreground">
            {t('coaching.deliveryVodPicker.capReached', { max: MAX_DELIVERY_VODS })}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('coaching.deliveryVodPicker.cancel')}
          </Button>
          <PendingButton type="button" pending={isPending} onClick={() => onConfirm(selected)}>
            {t('coaching.deliveryVodPicker.confirm')}
          </PendingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
