import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { localizedFighterName } from '@/lib/fighterNames';
import { useDeleteMatch } from '@/hooks/useDeleteMatch';
import { useDashboardContext } from '../DashboardContext';

const LIMIT_OPTIONS = [5, 10, 20, 30];

/** Ports legacy/src/screens/Dashboard/components/PreviousMatches. */
export function PreviousMatches({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
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
      toast.success(t('shared.matchDelete.deleted'));
    } catch {
      toast.error(t('shared.matchDelete.deleteFailed'));
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('dashboard.previous.title')}</CardTitle>
        {recent.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('dashboard.previous.limit')}</span>
            <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
              <SelectTrigger className="w-[80px]" aria-label={t('dashboard.previous.limitAria')}>
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
          <p className="text-sm text-muted-foreground">{t('dashboard.previous.empty')}</p>
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
                      <span className="text-xs">
                        {fighterSprite ? localizedFighterName(match.fighter_id, t) : ''}
                      </span>
                    </div>
                    <div className="flex flex-col items-center text-center">
                      {opponentSprite && (
                        <img src={opponentSprite.url} alt="" className="size-8 object-contain" />
                      )}
                      <span className="text-xs">
                        {opponentSprite ? localizedFighterName(match.opponent_id, t) : ''}
                      </span>
                    </div>
                    <span
                      className={`font-medium ${match.win ? 'text-emerald-500' : 'text-destructive'}`}
                    >
                      {match.win ? t('common.win') : t('common.loss')}
                    </span>
                  </div>
                  {/* Synced matches can't be deleted (the next sync would
                      just re-create them; the API 409s it) — manage them on
                      the Match Data page instead. */}
                  {!match.source && (
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={t('shared.matchDelete.aria')}
                      onClick={() => setPendingDelete(match)}
                    >
                      <Trash2 />
                    </Button>
                  )}
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
            <AlertDialogTitle>{t('shared.matchDelete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('common.cannotBeUndone')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
