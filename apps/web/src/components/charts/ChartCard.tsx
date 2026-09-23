import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export type ChartCardDensity = 'default' | 'compact';

export interface ChartCardProps {
  title: string;
  /** The evidence-type sentence (`shared.evidence.type.*`), rendered as the card's description — or, when `insight` is supplied, demoted to the footer at the meta role (UI-SPEC §7.9). */
  caption?: string;
  /** Header-right slot (sample cue, ruleset control, min-matches select) — `CardAction`. */
  headerRight?: ReactNode;
  /**
   * Controls that scope the card (plan 39.1-30, UI-SPEC §6.5 whole-token
   * wrap): rendered as `[data-slot="chart-card-toolbar"]`, the FIRST child of
   * the card content, in BOTH the abstained and the populated branch — a
   * control that scopes an abstained card (e.g. the assumption used to
   * compute it) must stay visible even when the card has nothing to show
   * (EVID-05 always-visible). The kit keeps its single abstention branch —
   * `toolbar` does not add a second one.
   */
  toolbar?: ReactNode;
  /** Non-null below the engine's abstention floor: swaps the body for the abstention sentence. */
  abstained?: { gamesNeeded: number } | null;
  /**
   * Renders above the plot, under the header: claim chip + verdict + evidence
   * (the `InsightCard` head without its card chrome) — UI-SPEC §7.9. Omitted
   * (`undefined`) is byte-identical to every Phase 37/38 call site. Supplied
   * as `null` (e.g. a dismissed insight) still demotes `caption` to the
   * footer and reserves no slot space — only whether the prop was supplied
   * at all decides the layout, not whether the node itself is truthy.
   */
  insight?: ReactNode;
  /** `'default'` (Phase 37/38 byte-unchanged) or `'compact'` (UI-SPEC §6.2: 20px padding ≥640px / 16px below, 16px header-to-content gap, no shadow) — applied by className composition on the composed `Card`/`CardHeader`/`CardContent`; the installed `Card` family is never edited. */
  density?: ChartCardDensity;
  footer?: ReactNode;
  children: ReactNode;
}

/** UI-SPEC §6.2 compact density — overrides `Card`'s default `py-6 shadow-sm` and `CardHeader`/`CardContent`'s default `px-6`, composed via className, never by editing `@/components/ui/card`. */
const COMPACT_CARD_CLASSES = 'gap-4 py-4 shadow-none sm:py-5';
const COMPACT_HEADER_CLASSES = 'px-4 sm:px-5';
const COMPACT_CONTENT_CLASSES = 'px-4 sm:px-5';

/**
 * The single chart frame every kit chart renders inside (CHRT-01). Every
 * advisor surface used to inline its own abstention branch and its own
 * header layout — this drift is exactly what `ChartCard` closes: one title
 * slot, one caption slot, one header-right slot, and one abstention branch
 * shared by every chart type. It is a thin composition over the existing
 * `Card` family, not a new visual system — it introduces no card variant, no
 * new surface color and no new spacing value.
 */
export function ChartCard({
  title,
  caption,
  headerRight,
  toolbar,
  abstained,
  insight,
  density = 'default',
  footer,
  children,
}: ChartCardProps) {
  const { t } = useTranslation();
  const hasInsightSlot = insight !== undefined;
  const isCompact = density === 'compact';
  return (
    <Card className={isCompact ? COMPACT_CARD_CLASSES : undefined}>
      <CardHeader className={isCompact ? COMPACT_HEADER_CLASSES : undefined}>
        <CardTitle>{title}</CardTitle>
        {caption && !hasInsightSlot && <CardDescription>{caption}</CardDescription>}
        {headerRight && <CardAction>{headerRight}</CardAction>}
      </CardHeader>
      <CardContent className={isCompact ? COMPACT_CONTENT_CLASSES : undefined}>
        {toolbar && (
          <div data-slot="chart-card-toolbar" className="min-w-0">
            {toolbar}
          </div>
        )}
        {abstained ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t('shared.evidence.abstained', { count: abstained.gamesNeeded })}
            </p>
            {/* WR-B01 (39.1-REVIEW.md): `hasInsightSlot` is computed from
                whether the `insight` PROP was supplied at all (line 62), not
                whether an insight actually exists this render, so a call
                site that always passes `insight={someInsight ?? null}` (a
                real, currently-shipping pattern — see `MatchupsPage.tsx`'s
                win-rate-trend chart) makes `hasInsightSlot` permanently
                true. The header's own caption is gated on `!hasInsightSlot`
                just above, so before this fix the evidence-type caption's
                ONLY other home was inside the non-abstained branch below —
                an abstained card with this call-site pattern rendered the
                caption NOWHERE. Mirrored here so it renders in this branch
                too. */}
            {caption && hasInsightSlot && (
              <p
                className="text-xs leading-4 text-muted-foreground tabular-nums"
                data-slot="chart-card-caption-footer"
              >
                {caption}
              </p>
            )}
          </>
        ) : (
          <>
            {hasInsightSlot && insight && <div data-slot="chart-card-insight">{insight}</div>}
            {children}
            {caption && hasInsightSlot && (
              <p
                className="text-xs leading-4 text-muted-foreground tabular-nums"
                data-slot="chart-card-caption-footer"
              >
                {caption}
              </p>
            )}
            {footer}
          </>
        )}
      </CardContent>
    </Card>
  );
}
