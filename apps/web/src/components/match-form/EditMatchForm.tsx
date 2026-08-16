import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Fighter, Match, UpdateMatchInput } from '@smash-tracker/shared';
import { formatTimestamp } from '@/lib/vod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import { useEnrichmentAttribution } from '@/hooks/useEnrichmentAttribution';
import {
  MatchFormFields,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';

/** Maps a stored `Match` to the shared form's value shape, applying legacy's fallbacks for older records missing optional fields. */
export function matchToFormValues(match: Match): MatchFormValues {
  return {
    fighterId: match.fighter_id,
    opponentFighterId: match.opponent_id,
    result: match.win ? 'win' : 'loss',
    stageId: match.map?.id ?? 0,
    // SETFEAT-02: carry the stored stage form through so editing and saving
    // without touching the toggle doesn't silently clear it (the shared
    // matchFormValuesToInput conditional-spread treats an unset toggle as
    // "no form recorded" — see its doc comment).
    stageForm: match.map?.form,
    matchType: match.matchType ? match.matchType : 'none',
    opponentName: match.opponent ?? '',
    notes: match.notes ?? '',
    stocksLeft: match.stocksLeft,
    eventName: match.eventName ?? '',
    tournamentName: match.tournamentName ?? '',
    // Prefilled with locale separators, matching what parseGspNumber accepts
    // back — a flubbed digit gets fixed in place instead of retyped.
    gsp: match.gsp !== undefined ? match.gsp.toLocaleString('en-US') : '',
    vodUrl: match.vodUrl ?? '',
    vodStartSeconds:
      match.vodStartSeconds !== undefined ? formatTimestamp(match.vodStartSeconds) : '',
  };
}

/**
 * Ports legacy/src/screens/MatchData/components/MatchTable/components/EditMatchForm.
 * Same fields as AddMatchForm (shared via `MatchFormFields`, which includes
 * the V4 Phase F stocks-left select and collapsible tournament section),
 * prefilled from the row being edited, and submits the FULL payload via
 * `useUpdateMatch` (PATCH `/api/matches/:id`, which legacy's edit form also
 * treated as a full overwrite — see `updateMatchInputSchema` in
 * packages/shared). Editing is always single-game; the set wizard only
 * appears in AddMatchForm.
 */
export function EditMatchForm({
  match,
  fighterSprites,
  open,
  onOpenChange,
  onDelete,
}: {
  match: Match;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * V14.1: renders a destructive Delete button in the footer when provided.
   * The caller owns the confirmation + mutation (every page already has a
   * delete AlertDialog) — this matters for entry points like the GSP curve's
   * click-to-edit, where the dialog is the only affordance for that match.
   */
  onDelete?: (match: Match) => void;
}) {
  const { t } = useTranslation();
  const updateMatch = useUpdateMatch();
  // requireOpponent: false — Quick Logger matches are stored with
  // `opponent: ''` (anonymous quickplay randoms) and must stay editable
  // without inventing a name; blank PATCHes through as "still anonymous".
  const form = useMatchForm(matchToFormValues(match), { requireOpponent: false });
  // Phase 30.2 Plan 11 (ENR-09): the witness lives OFF the match row — the
  // only way this form learns the CURRENT vodUrl value is source-owned. The
  // note appears only for a value that is both present and source-owned; a
  // user-entered value (no attribution record) renders no note. Saving is
  // still a full overwrite (module doc comment above `onSubmit`), which is
  // exactly the honest consequence the note states — the form does not
  // special-case the write path for a source-owned value.
  //
  // 30.2 gap-closure BLOCKER 2: reads the VOD HALF ONLY — a stage-only
  // witness must never make this form describe the user's own VOD as
  // source-owned.
  const matchKeys = useMemo(() => [match.id], [match.id]);
  const attribution = useEnrichmentAttribution(matchKeys);
  const vodIsSourceOwned = match.vodUrl != null && attribution[match.id]?.vod != null;
  // Phase 30.3 Gate 5: the same source-owned-note contract, extended to the
  // two new evidence halves — each reads ONLY its own half (same BLOCKER-2
  // discipline as `vodIsSourceOwned` above). `fighter_id`/`opponent_id` are
  // required positive ints on every stored `Match` (never absent the way
  // `vodUrl` legitimately can be), so unlike the VOD note this one gates on
  // nothing but the witness itself; `stocksLeft` mirrors `vodIsSourceOwned`'s
  // shape exactly, since it IS optional on a stored match.
  const charactersAreSourceOwned = attribution[match.id]?.characters != null;
  const stocksAreSourceOwned = match.stocksLeft != null && attribution[match.id]?.stocks != null;

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      form.reset(matchToFormValues(match));
    }
  }

  async function onSubmit(values: MatchFormValues) {
    // PATCH is a full overwrite (omitted = cleared). `vodUrl` is now owned by
    // this form (`matchFormValuesToInput` already omits it when blank —
    // clearing the field). `vodTimestamps` isn't collected here (that's
    // `VodNotesDialog`'s job) and is deliberately NEVER carried through —
    // `updateMatchInputSchema` no longer accepts the field at all, and the
    // server (`RtdbService.updateMatch`) preserves any existing note subtree
    // automatically on every match-fact PATCH that omits it (Phase 8). The
    // one legitimate "also clear notes" intent lives on `MatchTable`'s
    // explicit "Remove VOD link" action, not here.
    const input: UpdateMatchInput = matchFormValuesToInput(values);
    try {
      await updateMatch.mutateAsync({ id: match.id, input });
      toast.success(t('matchForm.edit.edited'));
      onOpenChange(false);
    } catch {
      toast.error(t('matchForm.edit.saveFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('matchForm.edit.title')}</DialogTitle>
          <DialogDescription>{t('matchForm.edit.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <MatchFormFields form={form} fighterSprites={fighterSprites} />
          {vodIsSourceOwned && (
            <p
              data-testid="edit-match-vod-source-owned-note"
              className="mt-1 text-xs text-muted-foreground"
            >
              {t('enrichment.editForm.sourceOwnedNote')}
            </p>
          )}
          {charactersAreSourceOwned && (
            <p
              data-testid="edit-match-characters-source-owned-note"
              className="mt-1 text-xs text-muted-foreground"
            >
              {t('enrichment.editForm.sourceOwnedNote')}
            </p>
          )}
          {stocksAreSourceOwned && (
            <p
              data-testid="edit-match-stocks-source-owned-note"
              className="mt-1 text-xs text-muted-foreground"
            >
              {t('enrichment.editForm.sourceOwnedNote')}
            </p>
          )}
          <DialogFooter className="mt-4">
            {onDelete && (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                onClick={() => onDelete(match)}
              >
                {t('matchForm.edit.deleteMatch')}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <PendingButton type="submit" pending={updateMatch.isPending}>
              {t('common.save')}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
