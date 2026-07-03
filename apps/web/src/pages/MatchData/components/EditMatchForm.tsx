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
  };
}

/**
 * Ports legacy/src/screens/MatchData/components/MatchTable/components/EditMatchForm.
 * Same fields as AddMatchForm (shared via `MatchFormFields`), prefilled from
 * the row being edited, and submits the FULL payload via `useUpdateMatch`
 * (PATCH `/api/matches/:id`, which legacy's edit form also treated as a full
 * overwrite — see `updateMatchInputSchema` in packages/shared).
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
    const input: UpdateMatchInput = matchFormValuesToInput(values);
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
