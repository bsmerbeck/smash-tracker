import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_INTENTS, type OnboardingIntent } from '@smash-tracker/shared';
import * as onboardingOrigin from '@/lib/onboardingOrigin';
import { useUpdateCoachingModeEnabled } from '@/hooks/useProfile';
import { intentDestination, useSaveOnboardingIntent } from '@/hooks/useOnboarding';
import { IntentOptionCard } from './components/IntentOptionCard';

const INTENT_ICONS: Record<OnboardingIntent, string> = {
  prepare: '🏆',
  review_vod: '🎬',
  track_improvement: '📈',
  scout: '🔍',
  coach_clients: '🎓',
};

function isOnboardingIntent(value: unknown): value is OnboardingIntent {
  return typeof value === 'string' && (ONBOARDING_INTENTS as readonly string[]).includes(value);
}

/**
 * `/welcome` — the one-intent-question chooser (D-01, ONBD-02). Route-visible
 * (§5: survives reload/deep-link/Back — a modal or dashboard takeover
 * cannot), auto-shown once for new accounts with no saved intent
 * (HomePage's routing branch) and re-enterable anytime.
 *
 * `preselect` arrives via router state (HomePage's ambiguous-origin branch,
 * D-02) — never a required param, so a bare `/welcome` visit (the no-origin
 * case, or a manual re-entry from the dashboard next-best-action area or a
 * switch-intent link) renders the plain chooser. A `?preselect=` query param
 * is also honored so the same pre-selection survives a page reload of this
 * route itself.
 *
 * Selecting an intent saves it server-side with `onboardingAsked: true`
 * (T-13-06-03: only an explicit click ever persists — pre-selection alone
 * never saves/navigates). Selecting `coach_clients` ALSO enables coaching
 * mode via the SAME mutation the Profile toggle uses (D-06) before
 * navigating. Skip saves nothing and lands on `/dashboard` — the dashboard's
 * next-best-action area (13-07) carries the compact re-entry, no nagging.
 */
export function WelcomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const saveIntent = useSaveOnboardingIntent();
  const enableCoaching = useUpdateCoachingModeEnabled();
  const [pendingIntent, setPendingIntent] = useState<OnboardingIntent | null>(null);
  const [error, setError] = useState(false);

  const statePreselect = (location.state as { preselect?: unknown } | null)?.preselect;
  const preselect = isOnboardingIntent(statePreselect)
    ? statePreselect
    : isOnboardingIntent(searchParams.get('preselect'))
      ? (searchParams.get('preselect') as OnboardingIntent)
      : null;

  const origin = onboardingOrigin.read();

  async function handleSelect(intent: OnboardingIntent) {
    setError(false);
    setPendingIntent(intent);
    try {
      if (intent === 'coach_clients') {
        await enableCoaching.mutateAsync(true);
      }
      await saveIntent.mutateAsync({ onboardingIntent: intent, onboardingAsked: true });
      navigate(intentDestination(intent), { replace: true });
    } catch {
      setError(true);
      setPendingIntent(null);
    }
  }

  function handleSkip() {
    navigate('/dashboard', { replace: true });
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
      {origin && (
        <a
          href={origin.returnPath}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          {t('onboarding.originChip.backToWatching')}
        </a>
      )}

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.welcome.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('onboarding.welcome.subtitle')}</p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('onboarding.welcome.error')}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {ONBOARDING_INTENTS.map((intent) => (
          <IntentOptionCard
            key={intent}
            intent={intent}
            icon={INTENT_ICONS[intent]}
            title={t(`onboarding.intent.${intent}.title`)}
            description={t(`onboarding.intent.${intent}.description`)}
            preselected={intent === preselect}
            wide={intent === 'coach_clients'}
            dashed={intent === 'coach_clients'}
            disabled={pendingIntent !== null}
            onSelect={handleSelect}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={handleSkip}
        disabled={pendingIntent !== null}
        className="w-fit text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {t('onboarding.welcome.skip')}
      </button>
    </div>
  );
}
