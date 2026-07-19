import { useTranslation } from 'react-i18next';
import { Ban } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The excluded-from-parity capabilities this component covers (CONTEXT.md
 * "Feature-Parity Scope"): account-linked start.gg/parry.gg sync, the GSP
 * tracker, billing/AI reports, and VOD share links. Each maps to a
 * `coaching.unavailable.<capability>.{title,reason}` i18n pair.
 */
export type UnavailableCapability = 'sync' | 'gsp' | 'billing' | 'vodShares';

interface UnavailableInCoachingProps {
  capability: UnavailableCapability;
  /**
   * `panel` (default) replaces a whole page/section — used for the
   * GSP/integrations/reports stub routes nested under `/coach/:clientId/*`.
   * `inline` replaces a single toolbar entry point (e.g. a "Share" button)
   * without breaking the surrounding layout — used for the VOD Manager's
   * share affordances.
   */
  variant?: 'panel' | 'inline';
  className?: string;
}

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, PAR-04 / T-11-14): the
 * ONE reusable "not available for managed clients" surface. Every capability
 * excluded from same-subject parity renders THIS component instead of ever
 * silently falling back to the coach's own personal data — no branch in this
 * codebase should render a personal-data view when `mode === 'coaching'` for
 * an excluded capability.
 */
export function UnavailableInCoaching({
  capability,
  variant = 'panel',
  className,
}: UnavailableInCoachingProps) {
  const { t } = useTranslation();
  const title = t(`coaching.unavailable.${capability}.title`);
  const reason = t(`coaching.unavailable.${capability}.reason`);

  if (variant === 'inline') {
    return (
      <span
        role="status"
        title={reason}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground',
          className,
        )}
      >
        <Ban className="size-3.5 shrink-0" />
        {title}
      </span>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center',
        className,
      )}
    >
      <Ban className="size-6 text-muted-foreground" />
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{reason}</p>
    </div>
  );
}
