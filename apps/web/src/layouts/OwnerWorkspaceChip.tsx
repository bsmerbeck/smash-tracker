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
