import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type ClaimChipKind = 'fact' | 'trend' | 'suggestion';

export interface ClaimChipProps {
  kind: ClaimChipKind;
  /** Adds a dashed border. `label` must already carry the locked suffix — the chip never localises. */
  locked?: boolean;
  /** Fully composed by the host, including the locked suffix when `locked` is true (Track B rule B1). */
  label: string;
}

/** One 8×8 shape per kind — decorative (`aria-hidden`); the word is the meaning, never the shape alone. */
function ClaimShape({ kind }: { kind: ClaimChipKind }) {
  switch (kind) {
    case 'fact':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <rect x="0" y="0" width="8" height="8" fill="currentColor" />
        </svg>
      );
    case 'trend':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M4 0 L8 4 L4 8 L0 4 Z" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      );
    case 'suggestion':
      return (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <circle cx="4" cy="4" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </svg>
      );
  }
}

/**
 * The three-word claim vocabulary — fact | trend | suggestion — plus a
 * locked modifier. Closed at three kinds (a `ClaimChipKind` outside the
 * union is a TypeScript error). The `ClaimKind` → chip-kind mapping lives in
 * the engine's consumer (plan 39.1-07), never here.
 */
export function ClaimChip({ kind, locked = false, label }: ClaimChipProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 gap-1 font-semibold tracking-wider text-[0.6875rem] text-muted-foreground uppercase',
        locked && 'border-dashed',
      )}
    >
      <ClaimShape kind={kind} />
      {label}
    </Badge>
  );
}
