import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * A sixth, intent-card-shaped action on `/welcome` (Phase 24, ENTRY-01) —
 * visually cloned from `IntentOptionCard`'s markup and class list, but not a
 * fork of its behavior: "I have a code from my coach" is an ACTION (navigate
 * to `/claim`), not one of the durable `ONBOARDING_INTENTS` categories, so
 * this card takes no `intent` prop, no `preselected` prop, and its
 * `onSelect` never saves anything or calls a profile mutation.
 */
export function ClaimCodeOptionCard({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-testid="claim-code-option"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'relative flex flex-col items-start gap-1 rounded-xl border border-dashed p-4 text-left transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'border-border hover:bg-accent/50',
      )}
    >
      <span aria-hidden="true" className="text-xl">
        🔑
      </span>
      <p className="font-medium">{t('onboarding.welcome.claimCodeCard.title')}</p>
      <p className="text-sm text-muted-foreground">
        {t('onboarding.welcome.claimCodeCard.description')}
      </p>
    </button>
  );
}
