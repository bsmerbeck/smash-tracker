import { useTranslation } from 'react-i18next';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';

/**
 * Phase 30.3 (Gate 6, owner/Codex hard gate): the ONE shared composition of
 * the demo-account label — every surface a login-bearing demo account can
 * reach renders THIS component, never a duplicated copy of its markup, so
 * the wording can never drift. It takes no props and consumes
 * `useIsDemoAccount()` itself, so a page can never opt out by forgetting to
 * pass a prop.
 *
 * Distinct from `ResearchSnapshotBanner`
 * (`@/pages/Coaching/components/ResearchSnapshotBanner.tsx`), which labels a
 * coach-managed RESEARCH TENANT workspace — the four demo accounts are
 * ordinary, login-bearing personal accounts, so that banner never fires for
 * them (see `useIsDemoAccount`'s doc comment). This component is what closes
 * that gap.
 *
 * Persistent (not a dismissible toast) — no close affordance exists, matches
 * `ResearchSnapshotBanner`'s own precedent for a persistent,
 * assistive-technology-announced advisory (`role="status"`). Callers mount
 * it at the very top of every returned render branch (loading, empty, and
 * populated) on each of the seven required surfaces so it's visible without
 * scrolling regardless of which branch a demo account's data happens to hit.
 *
 * Renders nothing for an ordinary account, or while the profile read is
 * pending/errored (`useIsDemoAccount()` defaults `false` in both cases) —
 * never a false positive on an ordinary account's screen.
 */
export function DemoAccountBanner() {
  const { t } = useTranslation();
  const isDemoAccount = useIsDemoAccount();

  if (!isDemoAccount) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="demo-account-banner"
      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
    >
      {t('demo.accountBanner')}
    </div>
  );
}
