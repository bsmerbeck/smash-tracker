import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Phase 11 walkthrough fix round 1 (FB-3): the full-page state `/coach/*`
 * renders for a signed-in user whose `coachingModeEnabled` profile flag
 * isn't `true` — coaching mode is opt-in (Profile > Account), so a direct
 * deep-link to a `/coach` URL (bookmark, shared link, browser back/forward)
 * must never dead-end; it always offers a way back into the app. Shares its
 * dashed-panel/`Ban`-icon visual language with `CoachingModeGate`'s other
 * gated states — this one specifically gates the whole `/coach/*` surface
 * before coaching mode has even been turned on.
 */
export function CoachingModeDisabled() {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center"
    >
      <Ban className="size-6 text-muted-foreground" />
      <h2 className="text-lg font-semibold">{t('coaching.disabled.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('coaching.disabled.body')}</p>
      <Button asChild>
        <Link to="/profile">{t('coaching.disabled.cta')}</Link>
      </Button>
    </div>
  );
}
