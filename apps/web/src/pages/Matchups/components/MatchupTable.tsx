import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t, i18n } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<Match | null>(null);
  const deleteMatch = useDeleteMatch();

  if (matchupMatches.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('matchups.table.empty')}</p>;
  }

  // Newest first, matching legacy's `.reverse()` after building `newData`.
  const rows = [...matchupMatches].sort((a, b) => b.time - a.time);

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMatch.mutateAsync(pendingDelete.id);
      toast.success(t('shared.matchDelete.deleted'));
    } catch {
      toast.error(t('shared.matchDelete.deleteFailed'));
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('matchups.table.date')}</TableHead>
            <TableHead>{t('matchups.stageTable.stage')}</TableHead>
            <TableHead>{t('matchups.table.result')}</TableHead>
            <TableHead className="text-right">{t('matchups.table.manage')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((match) => (
            <TableRow key={match.id}>
              <TableCell>{new Date(match.time).toLocaleString(i18n.language)}</TableCell>
              <TableCell>{match.map?.name ?? 'unknown'}</TableCell>
              <TableCell>{match.win ? t('common.win') : t('common.loss')}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('shared.matchDelete.aria')}
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
            <AlertDialogTitle>{t('shared.matchDelete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
