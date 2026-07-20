import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useStartggAutoSync } from '@/hooks/useStartgg';
import { GuidedPathCard } from '@/components/onboarding/GuidedPathCard';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Footer } from './Footer';

/** localStorage flag so the auto-detection notice fires once per browser, not once per visit. */
const LANGUAGE_TOAST_KEY = 'st-language-toast-shown';

/**
 * V15: one-time notice that the app auto-applied the browser's language
 * (i18next's navigator detection). Detection is silent by design — this
 * toast is the "suggestion" surface: it tells the user what happened and
 * where to change it (the topbar language bar). English needs no notice.
 */
function useLanguageDetectionNotice() {
  const { i18n, t } = useTranslation();
  useEffect(() => {
    const language = i18n.resolvedLanguage;
    if (!language || language === 'en' || localStorage.getItem(LANGUAGE_TOAST_KEY)) {
      return;
    }
    localStorage.setItem(LANGUAGE_TOAST_KEY, '1');
    const label = SUPPORTED_LANGUAGES.find((l) => l.code === language)?.label ?? language;
    toast.info(t('chrome.languageChanged', { language: label }));
  }, [i18n.resolvedLanguage, i18n, t]);
}

/**
 * Authenticated app shell: Topbar + persistent desktop Sidebar (mobile nav
 * lives in a Sheet triggered from Topbar) + Footer. Mirrors the structure of
 * legacy/src/layouts/Main without pixel-matching it. Wrapped in
 * `TooltipProvider` so any page can use `Tooltip`/`TooltipTrigger` without
 * repeating the provider setup (first consumer: the tournament detail
 * page's stage-chip and Advisor Retrospective tooltips).
 *
 * Phase 13 (ONBD-03, D-04): `GuidedPathCard` is mounted here, pinned above
 * every page's own content, so it follows the signed-in user across
 * whichever real feature page their saved onboarding intent lands on
 * (VOD Manager, Fighter Analysis, Tournaments, Scout, Client Hub) —
 * `GuidedPathCard` itself self-guards (renders nothing without a saved,
 * incomplete intent), so this mount is unconditional.
 */
export function MainLayout({ children }: { children: ReactNode }) {
  // page_view reporting lives in routes/RouteAnalytics.tsx (app-wide, public
  // pages included), not here.
  useLanguageDetectionNotice();
  // First-ever start.gg sync for a freshly-linked account (see the hook doc).
  useStartggAutoSync();
  return (
    <TooltipProvider>
      <div className="flex min-h-svh flex-col">
        <Topbar />
        <div className="flex flex-1">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <main className="flex-1 p-4 sm:p-6">
              <GuidedPathCard />
              {children}
            </main>
            <Footer />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
