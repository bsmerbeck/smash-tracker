import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { formatTimestamp } from '@/lib/vod';

export interface CitationChipProps {
  /** The source VOD's match id ({@link CitationToken.sourceVodRef}). */
  matchId: string;
  seconds: number;
  label: string;
  /**
   * A human-readable title for the source VOD — supplied only when the
   * citation references a DIFFERENT VOD than the one currently playing
   * (D-04 multi-VOD). Appended to the chip's accessible name so a
   * screen-reader user knows a click will switch sources, not just seek.
   */
  source?: string;
  /**
   * Fires on activation. Deciding seek-in-place vs. switch-source-then-seek
   * is entirely the CALLER's responsibility — this component never touches
   * player state itself (safeMarkdown.tsx's own `onActivateCitation`, or a
   * direct composer wiring, owns that decision).
   */
  onActivate: (matchId: string, seconds: number) => void;
}

/**
 * D-04: a real, keyboard-focusable `<button type="button">` — never a
 * `<span>`/`role="button"` div — carrying an accessible label describing
 * the jump target. Rendered by `safeMarkdown.tsx`'s inline parser for every
 * `{{cite:...}}` token; may also be rendered directly wherever a chip is
 * needed outside prose.
 */
export function CitationChip({ matchId, seconds, label, source, onActivate }: CitationChipProps) {
  const { t } = useTranslation();
  const timestamp = formatTimestamp(seconds);
  const base = source
    ? t('coaching.reviews.composer.citation.jumpToSourceAria', { timestamp, source })
    : t('coaching.reviews.composer.citation.jumpAria', { timestamp });
  const ariaLabel = label ? `${base}: ${label}` : base;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => onActivate(matchId, seconds)}
      className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 align-middle font-mono text-xs text-primary transition-colors hover:bg-primary/10"
    >
      <Play className="size-3" aria-hidden="true" />
      {timestamp}
      {label ? ` — ${label}` : null}
    </button>
  );
}
