import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * At most 3 doors, first is the primary. A fourth entry is a TypeScript
 * error — the cap is enforced by the type, not by convention (UI-SPEC §7.8).
 */
export type InsightCardDoors =
  | readonly []
  | readonly [ReactNode]
  | readonly [ReactNode, ReactNode]
  | readonly [ReactNode, ReactNode, ReactNode];

export type InsightCardDensity = 'default' | 'compact';

export interface InsightCardProps {
  /** The `ClaimChip` node. */
  chip: ReactNode;
  /** The meta-role name beside the chip in the header row. */
  name: string;
  /** The insight sentence — `verdict` role, wraps to at most 3 lines. */
  verdict: string;
  /** The record/interval sentence — `meta` role, tabular. */
  evidence: string;
  /** Mandatory for scoped cards (D-15) — the real date span. `meta` role. */
  span?: string;
  /** An optional inline visualization (dumbbell rows, `MiniStrip`, `RecordBar`, a meter list). */
  mark?: ReactNode;
  /** `body` role, muted, hidden between 1280px and 1535px (UI-SPEC §6.6). */
  sub?: ReactNode;
  /** `meta` role with a 2px left rule. */
  caveat?: string;
  /** Real router links built by the host — the frame renders the node it is given, never an `onClick` that mutates page state. */
  doors?: InsightCardDoors;
  onDismiss?: () => void;
  /** Accessible name for the dismiss control. Required whenever `onDismiss` is supplied. */
  dismissLabel?: string;
  density?: InsightCardDensity;
  className?: string;
}

/**
 * The insight frame (INS-04, UI-SPEC §7.8): one verdict, its evidence, and at
 * most three doors, in a fixed order. Composes the installed `Card` — never
 * edited — at compact density by default (20px padding, 16px header-to-body
 * gap, no shadow). Accepts no salience, ranking, tracking or watchlist prop:
 * a score or an inert control cannot reach the DOM through this type (DD-01,
 * T-39.1-07-02).
 */
export function InsightCard({
  chip,
  name,
  verdict,
  evidence,
  span,
  mark,
  sub,
  caveat,
  doors,
  onDismiss,
  dismissLabel,
  density = 'compact',
  className,
}: InsightCardProps) {
  return (
    <Card
      data-slot="insight-card"
      className={cn('gap-4 shadow-none', density === 'compact' ? 'p-5' : 'p-6', className)}
    >
      <div className="flex items-center justify-between gap-2" data-slot="insight-card-header">
        <div className="flex min-w-0 items-center gap-2">
          {chip}
          <span className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
            {name}
          </span>
        </div>
        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onDismiss}
            aria-label={dismissLabel}
          >
            <X />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3" data-slot="insight-card-content">
        <p
          className="line-clamp-3 text-base leading-6 font-medium text-pretty"
          data-slot="insight-card-verdict"
        >
          {verdict}
        </p>

        <p
          className="text-xs leading-4 text-muted-foreground tabular-nums"
          data-slot="insight-card-evidence"
        >
          {evidence}
        </p>

        {span && (
          <p
            className="text-xs leading-4 text-muted-foreground tabular-nums"
            data-slot="insight-card-span"
          >
            {span}
          </p>
        )}

        {mark && <div data-slot="insight-card-mark">{mark}</div>}

        {sub && (
          <div
            className="block text-sm leading-5 text-muted-foreground xl:hidden 2xl:block"
            data-slot="insight-card-sub"
          >
            {sub}
          </div>
        )}

        {caveat && (
          <p
            className="border-l-2 border-border pl-2 text-xs leading-4 text-muted-foreground tabular-nums"
            data-slot="insight-card-caveat"
          >
            {caveat}
          </p>
        )}

        {doors && doors.length > 0 && (
          <div className="flex flex-wrap gap-2" data-slot="insight-card-doors">
            {doors.map((door, index) => (
              <Button key={index} asChild variant={index === 0 ? 'default' : 'outline'} size="sm">
                {door}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
