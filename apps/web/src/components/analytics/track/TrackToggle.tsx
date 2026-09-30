import { Bookmark, BookmarkCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WatchlistItemKind, WatchlistTrackInput } from '@smash-tracker/shared';
import { Toggle } from '@/components/ui/toggle';
import {
  parseTrackInput,
  useIsTracked,
  useTrackWatchlistItem,
  useUntrackWatchlistItems,
} from '@/hooks/useWatchlist';
import { cn } from '@/lib/utils';

export interface TrackToggleProps {
  kind: WatchlistItemKind;
  /**
   * What is tracked: an opponent's resolved canonical tag, a matchup's
   * `{ fighterId, vsFighterId }`, or a stage id. Named `itemRef`, never
   * `ref`, which React reserves.
   */
  itemRef: WatchlistTrackInput['ref'] | null | undefined;
  /** The display name, for the accessible label and the toasts. */
  name: string;
  className?: string;
}

/**
 * UI-SPEC 7.7: the one watchlist write the UI performs. `Toggle` with
 * `aria-pressed`, always showing its word (never icon-only), pressed state
 * neutral (rule 10, never the brand colour). It reads and writes the ACTIVE
 * SUBJECT's list, so in coach view it curates the client's. It is disabled
 * and inert until the list query has succeeded (production-gap #8), and while
 * its own request is in flight. Renders nothing for a ref the server would
 * refuse (an opponent tag holding an RTDB path character, stage id 0). An
 * opponent is matched by resolved identity, like the Tracked section
 * (39.2-REVIEW WEB-WR-04).
 */
export function TrackToggle({ kind, itemRef, name, className }: TrackToggleProps) {
  const { t } = useTranslation();
  const { ready, tracked, itemKey, itemKeys } = useIsTracked(kind, itemRef);
  const track = useTrackWatchlistItem();
  const untrack = useUntrackWatchlistItems();
  const input = parseTrackInput(kind, itemRef);
  if (!input || itemKey == null) {
    return null;
  }

  const pending = track.isPending || untrack.isPending;
  const Icon = tracked ? BookmarkCheck : Bookmark;
  const label = t(tracked ? 'watchlist.tracked' : 'watchlist.track');
  const ariaLabel = t(tracked ? 'watchlist.untrackAria' : 'watchlist.trackAria', { name });

  function handlePressedChange(next: boolean) {
    // Never act on an unloaded or errored list (production-gap #8).
    if (!ready || pending || !input || itemKey == null) {
      return;
    }
    if (next) {
      track.mutate({ input, name });
    } else {
      // WEB-WR-04: every stored key the resolved identity folds, so the Dashboard row goes too.
      untrack.mutate({ itemKeys, name });
    }
  }

  return (
    <Toggle
      variant="outline"
      size="sm"
      data-slot="track-toggle"
      pressed={tracked}
      onPressedChange={handlePressedChange}
      disabled={!ready || pending}
      aria-label={ariaLabel}
      className={cn(
        'px-3 hover:bg-muted/40 data-[state=on]:border-foreground/40 data-[state=on]:bg-muted data-[state=on]:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-4',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span>{label}</span>
    </Toggle>
  );
}
