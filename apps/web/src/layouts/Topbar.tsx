import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LogOut, Menu } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle, SheetHeader } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuth } from '@/hooks/useAuth';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { useProfile } from '@/hooks/useProfile';
import { cn } from '@/lib/utils';
import { AnalyticsFilterControls } from '@/components/AnalyticsFilterControls';
import { LanguageSelect } from '@/components/LanguageSelect';
import { SidebarContent } from './SidebarContent';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-07): the Personal/
 * Coaching segmented control. `value` is DERIVED from `useActiveSubject()` —
 * never a separate `useState` mirror — so reload/Back/deep-link/mobile all
 * stay correct because mode lives in the route, not hidden component state.
 * Selecting Personal navigates to `/dashboard`; selecting Coaching navigates
 * to `/coach` (the hub) — same-value re-selects are ignored (Radix's
 * single-mode ToggleGroup fires `onValueChange('')` when the active item is
 * clicked again).
 */
function ModeSwitch({ mode, className }: { mode: 'personal' | 'coaching'; className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={mode}
      onValueChange={(next) => {
        if (next === 'personal') {
          navigate('/dashboard');
        } else if (next === 'coaching') {
          navigate('/coach');
        }
      }}
      aria-label={t('coaching.modeSwitch.ariaLabel')}
      className={className}
    >
      <ToggleGroupItem value="personal" size="sm">
        {t('coaching.modeSwitch.personal')}
      </ToggleGroupItem>
      <ToggleGroupItem value="coaching" size="sm">
        {t('coaching.modeSwitch.coaching')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/** The persistent client-name chip shown next to the mode switch in Coaching mode. */
function ClientChip({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const clients = useCoachingClients();
  const label = clients.data?.find((client) => client.clientId === clientId)?.label ?? clientId;

  return (
    <Badge variant="secondary" aria-label={t('coaching.clientChip.ariaLabel', { label })}>
      {label}
    </Badge>
  );
}

/**
 * Top app bar: title (links home), the Personal/Coaching mode switch + a
 * conditional client-name chip (Phase 11, TEN-07), the global analytics
 * filter (source + time range — hidden below `lg` for space, where it
 * instead appears at the top of the mobile nav Sheet), the language bar
 * (V15), sign-out, and a mobile menu toggle. In Coaching mode with an active
 * client, the header swaps its bottom border for an accent-tinted variant so
 * the mode reads as visually distinct without a full re-theme.
 */
export function Topbar() {
  const { signOut } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { mode, clientId } = useActiveSubject();
  const { data: profile } = useProfile();
  const isCoachingWithClient = mode === 'coaching' && clientId != null;
  // Phase 11 walkthrough fix round 1 (FB-3): coaching mode is opt-in
  // (Profile > Account) — hide the switch entirely for beginners who never
  // turned it on, UNLESS they're already deep-linked under `/coach` (mode is
  // 'coaching' for the hub AND the workspace post FB-1), so a bookmarked or
  // shared coaching URL never lands on a topbar with no way back to
  // Personal.
  const showModeSwitch = profile?.coachingModeEnabled === true || mode === 'coaching';

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/');
    } catch {
      toast.error(t('chrome.signOutFailed'));
    }
  };

  return (
    <header
      className={cn(
        'sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background px-4',
        isCoachingWithClient && 'border-b-2 border-b-primary',
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label={t('chrome.openMenu')}
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu className="size-5" />
      </Button>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="text-lg font-semibold tracking-tight"
        >
          grandfinals.gg
        </button>

        {showModeSwitch && <ModeSwitch mode={mode} className="hidden sm:flex" />}
        {isCoachingWithClient && <ClientChip clientId={clientId} />}
      </div>

      <div className="flex-1" />

      <AnalyticsFilterControls className="hidden lg:flex" />

      <LanguageSelect className="hidden sm:flex" />

      <Button variant="ghost" size="icon" aria-label={t('chrome.signOut')} onClick={handleSignOut}>
        <LogOut className="size-5" />
      </Button>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('chrome.navigation')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4 pb-0">
            {/* The mode switch hides in the topbar below `sm`; the mobile nav carries it instead. */}
            {showModeSwitch && <ModeSwitch mode={mode} className="sm:hidden" />}
            {isCoachingWithClient && (
              <div className="sm:hidden">
                <ClientChip clientId={clientId} />
              </div>
            )}
            <p className="text-xs font-medium text-muted-foreground">
              {t('chrome.analyticsFilters')}
            </p>
            <AnalyticsFilterControls />
            {/* The language bar hides in the topbar below `sm`; the mobile nav carries it instead. */}
            <LanguageSelect className="sm:hidden" />
          </div>
          <Separator className="mt-4" />
          <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </header>
  );
}
