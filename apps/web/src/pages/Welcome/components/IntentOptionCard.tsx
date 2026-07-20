import { useTranslation } from 'react-i18next';
import type { OnboardingIntent } from '@smash-tracker/shared';
import { cn } from '@/lib/utils';

/**
 * One selectable card on `/welcome` (D-01/D-02). Presentational — clicking
 * fires `onSelect` immediately (mirrors the approved mockup's `<a class="opt">`
 * cards: there is no separate "confirm" step, selecting an intent both saves
 * it and navigates). `preselected` renders the "Suggested for you" badge and
 * accent border for the ambiguous-origin ask variant (never auto-clicked —
 * only an explicit click ever saves/navigates, per T-13-06-03's accepted
 * spoofing note: the durable intent is only saved on user action).
 */
export function IntentOptionCard({
  intent,
  icon,
  title,
  description,
  preselected = false,
  wide = false,
  dashed = false,
  disabled = false,
  onSelect,
}: {
  intent: OnboardingIntent;
  icon: string;
  title: string;
  description: string;
  preselected?: boolean;
  wide?: boolean;
  dashed?: boolean;
  disabled?: boolean;
  onSelect: (intent: OnboardingIntent) => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-testid={`intent-option-${intent}`}
      aria-pressed={preselected}
      disabled={disabled}
      onClick={() => onSelect(intent)}
      className={cn(
        'relative flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        preselected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        dashed && 'border-dashed',
        wide && 'sm:col-span-2',
      )}
    >
      {preselected && (
        <span className="absolute top-3 right-3 text-[10px] font-bold tracking-wide text-primary uppercase">
          {t('onboarding.welcome.suggested')}
        </span>
      )}
      <span aria-hidden="true" className="text-xl">
        {icon}
      </span>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </button>
  );
}
