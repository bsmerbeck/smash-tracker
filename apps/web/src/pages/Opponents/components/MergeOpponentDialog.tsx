import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { OpponentSource } from '@/hooks/useFilteredMatches';
import { useUpsertOpponentAlias } from '@/hooks/useOpponentAliases';
import { rankMergeSuggestions } from '../mergeSuggestions';

export interface MergeOpponentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The opponent name being merged away (will become an alias). */
  opponent: string;
  /** Every other known opponent name, for the searchable target list. */
  candidates: string[];
  /** Source classification per opponent name, for the start.gg-tag-preservation warning. */
  sources: Map<string, OpponentSource>;
  onMerged?: () => void;
}

/**
 * "Merge into..." dialog: pick another opponent name that `opponent` should
 * be folded into. Confirming writes alias `opponent` -> `target` (target
 * becomes canonical). If `opponent` is start.gg-verified and `target` is
 * manual-only, warns that merging this direction would lose the start.gg
 * tag as canonical and offers the reversed direction instead (still
 * overridable — the user can proceed with their original choice).
 */
export function MergeOpponentDialog({
  open,
  onOpenChange,
  opponent,
  candidates,
  sources,
  onMerged,
}: MergeOpponentDialogProps) {
  const [target, setTarget] = useState<string | null>(null);
  const [confirmedDespiteWarning, setConfirmedDespiteWarning] = useState(false);
  const upsertAlias = useUpsertOpponentAlias();

  const ranked = useMemo(() => rankMergeSuggestions(opponent, candidates), [opponent, candidates]);

  // "Verified" here covers every non-manual source classification —
  // start.gg-only, parry.gg-only, or mixed (V8-A: seen on both tournament
  // sites, or a verified site plus manual matches) — any of them would lose
  // their verified badge if merged into a manual-only name as the alias.
  const opponentSource = sources.get(opponent);
  const wouldLoseVerifiedTag =
    target != null &&
    opponentSource != null &&
    opponentSource !== 'manual' &&
    sources.get(target) === 'manual';

  function reset() {
    setTarget(null);
    setConfirmedDespiteWarning(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  }

  function commitMerge(alias: string, canonical: string) {
    upsertAlias.mutate(
      { alias, input: { canonical } },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
          onMerged?.();
        },
      },
    );
  }

  function handleConfirm() {
    if (!target) {
      return;
    }
    if (wouldLoseVerifiedTag && !confirmedDespiteWarning) {
      // Recommended direction: keep the verified name canonical by
      // reversing the merge (target becomes the alias instead).
      commitMerge(target, opponent);
      return;
    }
    commitMerge(opponent, target);
  }

  /** "start.gg-verified" / "parry.gg-verified" / "verified" (mixed), matching the OpponentSourceBadge labels. */
  function verifiedLabel(source: OpponentSource | undefined): string {
    if (source === 'startgg') {
      return 'start.gg-verified';
    }
    if (source === 'parrygg') {
      return 'parry.gg-verified';
    }
    return 'verified';
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge &quot;{opponent}&quot; into...</DialogTitle>
          <DialogDescription>
            Choose the opponent name that should be treated as the same person. Their matches will
            be combined everywhere.
          </DialogDescription>
        </DialogHeader>

        <Command className="rounded-md border">
          <CommandInput placeholder="Search opponents..." />
          <CommandList>
            <CommandEmpty>No matching opponents.</CommandEmpty>
            <CommandGroup>
              {ranked.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  onSelect={() => {
                    setTarget(name);
                    setConfirmedDespiteWarning(false);
                  }}
                  aria-selected={target === name}
                  data-selected={target === name || undefined}
                >
                  {name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        {target && wouldLoseVerifiedTag && !confirmedDespiteWarning && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            <p>
              &quot;{opponent}&quot; is {verifiedLabel(opponentSource)} and &quot;{target}&quot; is
              manual-only. To keep the verified tag as canonical, we&apos;ll merge &quot;{target}
              &quot; into &quot;{opponent}&quot; instead.
            </p>
            <Button
              type="button"
              variant="link"
              className="mt-1 h-auto p-0 text-sm"
              onClick={() => setConfirmedDespiteWarning(true)}
            >
              Merge &quot;{opponent}&quot; into &quot;{target}&quot; anyway
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!target || upsertAlias.isPending} onClick={handleConfirm}>
            {upsertAlias.isPending ? 'Merging...' : 'Merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
