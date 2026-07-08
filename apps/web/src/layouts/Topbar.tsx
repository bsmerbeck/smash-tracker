import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { LogOut, Menu } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle, SheetHeader } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { AnalyticsFilterControls } from '@/components/AnalyticsFilterControls';
import { LanguageSelect } from '@/components/LanguageSelect';
import { SidebarContent } from './SidebarContent';

/**
 * Top app bar: title (links home), the global analytics filter (source +
 * time range — hidden below `lg` for space, where it instead appears at the
 * top of the mobile nav Sheet), the language bar (V15), sign-out, and a
 * mobile menu toggle.
 */
export function Topbar() {
  const { signOut } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/');
    } catch {
      toast.error(t('chrome.signOutFailed'));
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label={t('chrome.openMenu')}
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu className="size-5" />
      </Button>

      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        className="text-lg font-semibold tracking-tight"
      >
        Smash Tracker
      </button>

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
