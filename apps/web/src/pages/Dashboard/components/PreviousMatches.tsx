import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Match } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { getLastNMatches } from '@/lib/stats';
import { getFighterById } from '@/data/sprites';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useDashboardContext } from '../DashboardContext';

const LIMIT_OPTIONS = [5, 10, 20, 30];

/** Ports legacy/src/screens/Dashboard/components/PreviousMatches. */
export function PreviousMatches({ matches }: { matches: Match[] }) {
  const { fighter } = useDashboardContext();
  const [limit, setLimit] = useState(5);
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();

  const fighterMatches = fighter ? matches.filter((m) => m.fighter_id === fighter.id) : [];
  const recent = getLastNMatches(fighterMatches, limit);

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMatch.mutateAsync(pendingDelete.id);
      toast.success('Match deleted!');
    } catch {
      toast.error('Failed to delete match. Please try again.');
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Previous Matches</CardTitle>
        {recent.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Limit</span>
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="w-[80px]" aria-label="Match limit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recent.map((match) => {
              const fighterSprite = getFighterById(match.fighter_id);
              const opponentSprite = getFighterById(match.opponent_id);
              return (
                <li
                  key={match.id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center text-center">
                      {fighterSprite && (
                        <img src={fighterSprite.url} alt="" className="size-8 object-contain" />
                      )}
                      <span className="text-xs">{fighterSprite?.name}</span>
                    </div>
                    <div className="flex flex-col items-center text-center">
                      {opponentSprite && (
                        <img src={opponentSprite.url} alt="" className="size-8 object-contain" />
                      )}
                      <span className="text-xs">{opponentSprite?.name}</span>
                    </div>
                    <span
                      className={`font-medium ${match.win ? 'text-emerald-500' : 'text-destructive'}`}
                    >
                      {match.win ? 'Win' : 'Loss'}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Delete match"
                    onClick={() => setPendingDelete(match)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this match?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
