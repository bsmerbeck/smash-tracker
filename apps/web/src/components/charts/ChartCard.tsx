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

export interface ChartCardProps {
  title: string;
  /** The evidence-type sentence (`shared.evidence.type.*`), rendered as the card's description. */
  caption?: string;
  /** Header-right slot (sample cue, ruleset control, min-matches select) — `CardAction`. */
  headerRight?: ReactNode;
  /** Non-null below the engine's abstention floor: swaps the body for the abstention sentence. */
  abstained?: { gamesNeeded: number } | null;
  footer?: ReactNode;
  children: ReactNode;
}

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
  abstained,
  footer,
  children,
}: ChartCardProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {caption && <CardDescription>{caption}</CardDescription>}
        {headerRight && <CardAction>{headerRight}</CardAction>}
      </CardHeader>
      <CardContent>
        {abstained ? (
          <p className="text-sm text-muted-foreground">
            {t('shared.evidence.abstained', { count: abstained.gamesNeeded })}
          </p>
        ) : (
          <>
            {children}
            {footer}
          </>
        )}
      </CardContent>
    </Card>
  );
}
