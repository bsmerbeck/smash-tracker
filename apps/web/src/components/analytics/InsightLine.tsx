import type { ReactNode } from 'react';

export type InsightLineTone = 'steady' | 'notable';

export interface InsightLineProps {
  text: string;
  /** The `ClaimChip` node — rendered instead of the steady bar in the `notable` tone. */
  chip?: ReactNode;
  tone: InsightLineTone;
}

/**
 * The non-card insight form (UI-SPEC §7.8). `steady` results inside a rail,
 * and the text verdict lines living inside another card (`SettingGap`,
 * `VolumeForm`, `MixShift`), render here. It is never a `Card`: no doors, no
 * dismiss.
 */
export function InsightLine({ text, chip, tone }: InsightLineProps) {
  if (tone === 'notable') {
    return (
      <p
        className="flex items-center gap-2 text-base leading-6 font-medium text-pretty"
        data-slot="insight-line"
        data-tone="notable"
      >
        {chip}
        <span>{text}</span>
      </p>
    );
  }

  return (
    <p
      className="flex items-center gap-2 text-sm leading-5 text-muted-foreground"
      data-slot="insight-line"
      data-tone="steady"
    >
      <svg width="8" height="2" viewBox="0 0 8 2" aria-hidden="true" className="shrink-0">
        <rect width="8" height="2" fill="var(--steady)" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
