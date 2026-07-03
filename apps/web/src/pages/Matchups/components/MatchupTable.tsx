import { useState } from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { useDeleteMatch } from '@/hooks/useDeleteMatch';

/** Ports legacy/src/screens/Matchups/components/MatchupTable — list of matches for the specific matchup, newest first, with delete + confirm. */
export function MatchupTable({ matchupMatches }: { matchupMatches: Match[] }) {
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();

  if (matchupMatches.length === 0) {
    return <p className="text-sm text-muted-foreground">No matches reported yet!</p>;
  }

  // Newest first, matching legacy's `.reverse()` after building `newData`.
  const rows = [...matchupMatches].sort((a, b) => b.time - a.time);

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
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Manage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((match) => (
            <TableRow key={match.id}>
              <TableCell>{new Date(match.time).toLocaleString()}</TableCell>
              <TableCell>{match.map?.name ?? 'unknown'}</TableCell>
              <TableCell>{match.win ? 'Win' : 'Loss'}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Delete match"
                  onClick={() => setPendingDelete(match)}
                >
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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
    </>
  );
}
