import { toast } from 'sonner';
import type { Fighter, Match, UpdateMatchInput } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUpdateMatch } from '@/hooks/useUpdateMatch';
import {
  MatchFormFields,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';

/** Maps a stored `Match` to the shared form's value shape, applying legacy's fallbacks for older records missing optional fields. */
function matchToFormValues(match: Match): MatchFormValues {
  return {
    fighterId: match.fighter_id,
    opponentFighterId: match.opponent_id,
    result: match.win ? 'win' : 'loss',
    stageId: match.map?.id ?? 0,
    matchType: match.matchType ? match.matchType : 'none',
    opponentName: match.opponent ?? '',
    notes: match.notes ?? '',
    stocksLeft: match.stocksLeft,
    eventName: match.eventName ?? '',
    tournamentName: match.tournamentName ?? '',
    // Prefilled with locale separators, matching what parseGspNumber accepts
    // back — a flubbed digit gets fixed in place instead of retyped.
    gsp: match.gsp !== undefined ? match.gsp.toLocaleString('en-US') : '',
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
}: {
  match: Match;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateMatch = useUpdateMatch();
  const form = useMatchForm(matchToFormValues(match));

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      form.reset(matchToFormValues(match));
    }
  }

  async function onSubmit(values: MatchFormValues) {
    // PATCH is a full overwrite (omitted = cleared), so fields this form
    // doesn't own must be carried through from the record or editing a match
    // silently wipes its VOD link/notes (it used to).
    const input: UpdateMatchInput = {
      ...matchFormValuesToInput(values),
      ...(match.vodUrl !== undefined ? { vodUrl: match.vodUrl } : {}),
      ...(match.vodTimestamps !== undefined ? { vodTimestamps: match.vodTimestamps } : {}),
    };
    try {
      await updateMatch.mutateAsync({ id: match.id, input });
      toast.success('Match edited!');
      onOpenChange(false);
    } catch {
      toast.error('Failed to save match. Please try again.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Match</DialogTitle>
          <DialogDescription>Update the details of this recorded match.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <MatchFormFields form={form} fighterSprites={fighterSprites} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={updateMatch.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
