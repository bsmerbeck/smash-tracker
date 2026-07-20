import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export interface ReviewSourcesDrawerProps {
  /** Every VOD-bearing match in the client's library — the composer's candidate source list (D-01/D-04: multi-VOD reviews are first-class). */
  sources: Match[];
  /** The match id the left pane is currently playing, or `null` if no source is selected yet. */
  currentSourceId: string | null;
  /** Switches the composer's active source. Closes the drawer itself. */
  onSelect: (matchId: string) => void;
}

/**
 * The `Sources ▾` drawer (D-01): lists the client's VOD library so the coach
 * can add/switch which VOD the left pane's player + Evidence list are
 * currently showing. Plan 12-07 wires the Evidence list itself; this plan
 * only needs source SELECTION to exist so the player has something to key
 * on. No durable "review sources" schema exists yet (Claude's Discretion,
 * 12-CONTEXT.md) — the current source is local composer state, reset each
 * time the composer mounts (matches D-01's "preloaded from Start review"
 * flow for the common single-source case; explicit multi-VOD switching is
 * a per-session choice until a later plan needs to persist it).
 */
export function ReviewSourcesDrawer({
  sources,
  currentSourceId,
  onSelect,
}: ReviewSourcesDrawerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          {t('coaching.reviews.composer.sourcesDrawer.trigger')}
        </Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{t('coaching.reviews.composer.sourcesDrawer.title')}</SheetTitle>
          <SheetDescription>
            {t('coaching.reviews.composer.sourcesDrawer.description')}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-1 overflow-y-auto px-4 pb-4">
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('coaching.reviews.composer.sourcesDrawer.empty')}
            </p>
          ) : (
            sources.map((match) => {
              const isCurrent = match.id === currentSourceId;
              const opponent = match.opponent || t('common.unknown');
              return (
                <button
                  key={match.id}
                  type="button"
                  onClick={() => {
                    onSelect(match.id);
                    setOpen(false);
                  }}
                  aria-current={isCurrent}
                  className={cn(
                    'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                    isCurrent && 'border-primary bg-accent text-accent-foreground',
                  )}
                >
                  <span className="font-medium">
                    {t('coaching.reviews.composer.sourcesDrawer.vsOpponent', { opponent })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tournamentLabel(match)} · {new Date(match.time).toLocaleDateString()}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
