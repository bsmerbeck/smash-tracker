import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type InsightLineTone = 'steady' | 'notable';

export interface InsightLineProps {
  text: string;
  /** The `ClaimChip` node — rendered instead of the steady bar in the `notable` tone. */
  chip?: ReactNode;
  tone: InsightLineTone;
  /**
   * Plan 39.1-27 (gap closure, SC4/INS-04): at most one door, supplied by
   * the host — never a dismiss. The host passes a bare `<Link>`; this
   * component wraps it in `Button asChild size="sm" variant="link"` (a line
   * is not a card, so it never takes the card's brand-red primary fill,
   * UI-SPEC §7.8). With no door, this component's markup is byte-identical
   * to before this prop existed.
   */
  door?: ReactNode;
}

/**
 * The non-card insight form (UI-SPEC §7.8). `steady` results inside a rail,
 * and the text verdict lines living inside another card (`SettingGap`,
 * `VolumeForm`, `MixShift`), render here. It is never a `Card`: at most one
 * door (see `door` above), no dismiss.
 */
export function InsightLine({ text, chip, tone, door }: InsightLineProps) {
  if (tone === 'notable') {
    return (
      <p
        className={cn(
          'flex items-center gap-2 text-base leading-6 font-medium text-pretty',
          door && 'flex-wrap',
        )}
        data-slot="insight-line"
        data-tone="notable"
      >
        {chip}
        <span>{text}</span>
        {door && (
          <span data-slot="insight-line-door" className="shrink-0">
            <Button asChild size="sm" variant="link">
              {door}
            </Button>
          </span>
        )}
      </p>
    );
  }

  return (
    <p
      className={cn(
        'flex items-center gap-2 text-sm leading-5 text-muted-foreground',
        door && 'flex-wrap',
      )}
      data-slot="insight-line"
      data-tone="steady"
    >
      <svg width="8" height="2" viewBox="0 0 8 2" aria-hidden="true" className="shrink-0">
        <rect width="8" height="2" fill="var(--steady)" />
      </svg>
      <span>{text}</span>
      {door && (
        <span data-slot="insight-line-door" className="shrink-0">
          <Button asChild size="sm" variant="link">
            {door}
          </Button>
        </span>
      )}
    </p>
  );
}
