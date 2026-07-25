import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useClientWorkspaces } from '@/hooks/useClientWorkspaces';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): wraps the
 * `/workspace/:tenantId/*` family. This gate is a UX affordance, NOT the
 * authorization boundary — it exists so an owner is never shown a broken
 * page for a tenant they don't (or no longer) own, and its admit condition
 * is backed by the server's own answer (`GET /api/client-workspaces`,
 * consumed below) rather than by the route param alone. The real
 * enforcement is server-side and per request: `resolveSubjectId`
 * (`apps/api/src/coaching/subject.ts`) re-reads
 * `clientMembers/{tenantId}/{uid}` on every subject-scoped call and throws a
 * 403 on absence, and the destructive coach routes additionally role-gate
 * through `requireTenantRole`. A UI switcher must never become an
 * authorization mechanism. This deliberately does NOT gate on the coach's
 * own opt-in profile toggle (the condition the coach-side gate uses) — that
 * flag is unrelated to owning a claimed workspace, and a client-owner almost
 * never has it set.
 *
 * Fork template: `apps/web/src/pages/Coaching/` coach-side gate (whole file,
 * 27 lines). The loading-renders-nothing convention is carried over
 * unchanged.
 */
export function ClientOwnedWorkspaceGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { tenantId } = useOwnedWorkspaceSubject();
  const { data: workspaces, isLoading } = useClientWorkspaces();

  if (isLoading) {
    return null;
  }

  const isOwned = workspaces?.some((workspace) => workspace.tenantId === tenantId) ?? false;

  if (!isOwned) {
    return (
      <div
        role="status"
        className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center"
      >
        <h2 className="text-lg font-semibold">{t('ownerWorkspace.notAuthorized.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('ownerWorkspace.notAuthorized.body')}</p>
        <Link to="/dashboard" className="text-sm font-medium underline underline-offset-4">
          {t('ownerWorkspace.notAuthorized.backToDashboard')}
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
