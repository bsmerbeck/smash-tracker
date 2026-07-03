import { useState } from 'react';
import { toast } from 'sonner';
import type { CreateMatchInput } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import {
  MatchFormFields,
  alphaSpriteList,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';
import { useDashboardContext } from '../DashboardContext';

function buildDefaultValues(fighterId: number): MatchFormValues {
  return {
    fighterId,
    opponentFighterId: alphaSpriteList[0]?.id ?? 0,
    result: undefined as unknown as MatchFormValues['result'],
    stageId: NO_SELECTION_STAGE.id,
    matchType: 'none',
    opponentName: '',
    notes: '',
  };
}

/**
 * Ports legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm.
 * Opens from a trigger button in the dashboard toolbar; submits via
 * useCreateMatch (which invalidates matches + opponents so a newly typed
 * opponent name shows up next time). Field UI lives in the shared
 * `MatchForm` component so EditMatchForm (MatchData screen) doesn't
 * duplicate it.
 */
export function AddMatchForm() {
  const { fighter, fighterSprites } = useDashboardContext();
  const createMatch = useCreateMatch();
  const [open, setOpen] = useState(false);

  const form = useMatchForm(buildDefaultValues(fighter?.id ?? fighterSprites[0]?.id ?? 0));

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      form.reset(buildDefaultValues(fighter?.id ?? fighterSprites[0]?.id ?? 0));
    }
  }

  async function onSubmit(values: MatchFormValues) {
    const input: CreateMatchInput = matchFormValuesToInput(values);
    try {
      await createMatch.mutateAsync(input);
      toast.success('Match added!');
      setOpen(false);
    } catch {
      toast.error('Failed to add match. Please try again.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={fighterSprites.length === 0}>Add Match</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Match</DialogTitle>
          <DialogDescription>Record the outcome of a match you just played.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <MatchFormFields form={form} fighterSprites={fighterSprites} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMatch.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
