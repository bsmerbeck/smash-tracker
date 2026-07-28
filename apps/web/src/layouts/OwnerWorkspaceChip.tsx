import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useClientWorkspaces } from '@/hooks/useClientWorkspaces';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01): the
 * owned-workspace switcher chip shown in the Topbar while browsing a
 * claimed workspace (`/workspace/:tenantId/*`). A deliberate visual sibling
 * of this file's neighboring client-switcher chip — forked for its
 * dropdown-menu shape, never imported or extended — because the neighbor is
 * backed by the coach's own managed-client listing, which is legitimately
 * empty for a client who owns a workspace themselves. Backed instead by the
 * signed-in user's own owned-workspace listing (`GET /api/client-workspaces`).
 * Styled neutrally, with no accent-color coach-mode styling, so it never
 * reads as coach chrome to a client-owner. Purely a navigation affordance:
 * selecting an entry only navigates; every request against the destination
 * is re-authorized server-side against the membership record, so this chip
 * grants no access by itself.
 */
export function OwnerWorkspaceChip({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaces = useClientWorkspaces();
  const activeLabel =
    workspaces.data?.find((workspace) => workspace.tenantId === tenantId)?.label ?? tenantId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('ownerWorkspace.chrome.chipAriaLabel', { label: activeLabel })}
          className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/40 bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {activeLabel}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('ownerWorkspace.chrome.switchWorkspace')}</DropdownMenuLabel>
        {(workspaces.data ?? []).map((workspace) => {
          const isActive = workspace.tenantId === tenantId;
          return (
            <DropdownMenuItem
              key={workspace.tenantId}
              aria-label={
                isActive
                  ? t('ownerWorkspace.chrome.currentAria', { label: workspace.label })
                  : undefined
              }
              onSelect={() => {
                if (!isActive) {
                  navigate(`/workspace/${workspace.tenantId}/overview`);
                }
              }}
            >
              {isActive ? <Check className="size-4" /> : <span className="size-4" />}
              {workspace.label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/dashboard')}>
          {t('ownerWorkspace.chrome.backToPersonal')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Quick 260726-r5 (Phase 24 gap 1): the discoverable entry point INTO an
 * owned workspace, shown from every route OUTSIDE `/workspace/:tenantId/*`
 * (Personal and Coaching alike — Topbar renders it whenever `isOwnerWorkspace`
 * is false). Before this fix, `OwnerWorkspaceChip` above only rendered once
 * already inside the workspace, so a claimed client who navigated away (or
 * landed on `/dashboard` after sign-in) had no way back in short of the
 * browser Back button. A deliberate sibling of `OwnerWorkspaceChip` — same
 * `useClientWorkspaces()` source (never `useCoachingClients()`), same
 * navigation-only contract (every destination route is re-authorized
 * server-side against the membership record; this chip grants no access by
 * itself) — but never imported/extended from it, because the two chips are
 * mutually exclusive by route and need different "nothing to show yet"
 * behavior: this one renders nothing at all with zero owned workspaces
 * (no empty affordance), where the in-workspace chip always has exactly one
 * guaranteed entry (the current tenant).
 *
 * Single owned workspace: a plain button, labeled with the workspace's own
 * label, that navigates directly — no dropdown needed for one destination.
 * Multiple owned workspaces: a "My Workspace" dropdown trigger listing every
 * one of them (per Phase 24 gap 1's "with multiple owned workspaces, list
 * them" requirement).
 */
export function OwnerWorkspaceEntryChip() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaces = useClientWorkspaces();
  const data = workspaces.data ?? [];

  if (data.length === 0) {
    return null;
  }

  if (data.length === 1) {
    const workspace = data[0]!;
    return (
      <button
        type="button"
        aria-label={t('ownerWorkspace.chrome.entryAriaLabel', { label: workspace.label })}
        onClick={() => navigate(`/workspace/${workspace.tenantId}/overview`)}
        className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/40 bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {workspace.label}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('ownerWorkspace.chrome.entryMenuAriaLabel')}
          className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/40 bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {t('ownerWorkspace.chrome.entryLabel')}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('ownerWorkspace.chrome.entryMenuLabel')}</DropdownMenuLabel>
        {data.map((workspace) => (
          <DropdownMenuItem
            key={workspace.tenantId}
            onSelect={() => navigate(`/workspace/${workspace.tenantId}/overview`)}
          >
            {workspace.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
