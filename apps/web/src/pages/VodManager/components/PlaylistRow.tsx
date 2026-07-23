import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * One match row for the playlist view (LIST-02/LIST-03) — modeled on
 * `TimestampRow`'s "primary click target + sibling icon buttons" layout.
 * The select button reuses `VodMatchList`'s `MatchRow` content/formatting
 * plus the D-13 selection tokens; up/down reorder arrows are gated on
 * `reorderPending` (RESEARCH.md Pitfall 3 — the full-array PATCH race guard
 * on rapid clicks) in addition to their own boundary (`canMoveUp`/
 * `canMoveDown`). Remove is a direct action — removing a match from a
 * playlist never touches the match itself, so no AlertDialog confirm here
 * (that's reserved for deleting the whole playlist).
 */
export function PlaylistRow({
  match,
  isSelected,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
  canMoveUp,
  canMoveDown,
  reorderPending,
}: {
  match: Match;
  isSelected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Whether a reorder mutation is currently in flight — disables BOTH arrow
   * buttons regardless of boundary, preventing rapid clicks from firing a
   * second full-array PATCH before the first one lands (race guard). */
  reorderPending: boolean;
}) {
  const { t } = useTranslation();
  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);
  const opponent = match.opponent || t('common.unknown');

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onSelect}
        aria-label={t('vodManager.selectMatchAria', { opponent })}
        className={cn(
          'flex flex-1 flex-col items-start gap-0.5 rounded-md border border-primary p-2 text-left text-sm text-primary transition-colors hover:bg-accent hover:text-accent-foreground',
          isSelected && 'bg-accent text-accent-foreground border-l-2 border-primary',
        )}
      >
        <span className="font-medium">
          {fighter ? localizedFighterName(match.fighter_id, t) : t('common.unknown')} vs{' '}
          {opponentFighter ? localizedFighterName(match.opponent_id, t) : t('common.unknown')}
        </span>
        <span className="text-xs opacity-80">
          {opponent} · {tournamentLabel(match)} · {new Date(match.time).toLocaleDateString()}
        </span>
      </button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t('vodManager.playlists.moveUp')}
        disabled={reorderPending || !canMoveUp}
        onClick={onMoveUp}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t('vodManager.playlists.moveDown')}
        disabled={reorderPending || !canMoveDown}
        onClick={onMoveDown}
      >
        <ArrowDown />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t('vodManager.playlists.removeFromPlaylist')}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}
