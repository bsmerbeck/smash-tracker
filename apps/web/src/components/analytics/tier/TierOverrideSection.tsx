import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  TIER_WORDS,
  type TierResolution,
  type TierWord,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTierOverride } from '@/hooks/useTierOverride';
import { TierBadge } from './TierBadge';
import { TierProvenanceLine } from './TierProvenanceLine';
import { estimatedProvenanceMessage, useTierProvenanceText } from './tierProvenance';

const TIER_SELECT_ID = 'tier-override-select';

export interface TierOverrideSectionProps {
  entry: Pick<TournamentEntry, 'entryKey' | 'tierOverride'>;
  /** The resolution `TournamentDetailPage` computed once for this entry. */
  resolution: TierResolution;
}

/**
 * Tournament-detail tier disclosure and per-event override (TIER-04, D-15,
 * UI-SPEC §7.6), the sibling of `RulesetOverrideSection`. Renders for every
 * entry including admin-imported ones, own-account only (D-17).
 *
 * Choosing a word SAVES IMMEDIATELY and sends only the member the user
 * touched. The WR-02 rule ("an untouched member is omitted, never resent as a
 * snapshot", `RulesetOverrideSection`'s baseline-diff `buildPayload`) reduces
 * to exactly that here because `tier` is the only user-editable member. A
 * future editable member must adopt that baseline-diff `buildPayload` instead
 * of widening this call.
 *
 * The Select is controlled by the STORED value, never by local state, so a
 * failed save leaves the stored word showing and nothing optimistic persists.
 * An override written by a newer contract version is ignored whole by the
 * resolver: the Select then shows the placeholder (nothing is applied) and
 * the disclosure line says why, while a fresh save is still allowed.
 */
export function TierOverrideSection({ entry, resolution }: TierOverrideSectionProps) {
  const { t, i18n } = useTranslation();
  const mutation = useTierOverride(entry.entryKey ?? '');
  const provenance = useTierProvenanceText(resolution) ?? '';

  const isManual = resolution.basis === 'manual';
  const hasStoredOverride = entry.tierOverride != null;
  const selectedTier: TierWord | '' = isManual ? resolution.tier : '';

  const estimate = isManual ? resolution.estimate : null;
  const estimateSentence = (() => {
    if (!estimate) {
      return null;
    }
    const message = estimatedProvenanceMessage(estimate.entrants, i18n.language);
    return t('tiers.override.wouldBe', {
      tier: t(`tiers.label.${estimate.tier}`),
      provenance: t(message.key, message.values),
    });
  })();

  function save(tierOverride: { tier: TierWord } | null) {
    mutation.mutate(tierOverride, {
      onSuccess: () => {
        toast.success(t('tiers.override.saved'));
      },
      onError: () => {
        toast.error(t('tiers.override.saveFailed'));
      },
    });
  }

  return (
    <Card data-slot="tier-override">
      <CardHeader>
        <CardTitle>{t('tiers.override.title')}</CardTitle>
        {isManual && (
          <CardAction>
            <Badge variant="outline">{t('shared.ruleset.overrideBadge')}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge
              tier={resolution.tier}
              basis={resolution.basis}
              source={resolution.source}
              provenance={provenance}
            />
            <TierProvenanceLine resolution={resolution} />
          </div>
          {estimateSentence && (
            <p className="text-xs leading-4 text-muted-foreground tabular-nums">
              {estimateSentence}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={TIER_SELECT_ID}>{t('tiers.override.label')}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={selectedTier}
              onValueChange={(value) => save({ tier: value as TierWord })}
              disabled={mutation.isPending}
            >
              <SelectTrigger id={TIER_SELECT_ID} className="w-56">
                <SelectValue placeholder={t('tiers.override.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {TIER_WORDS.map((word) => (
                  <SelectItem key={word} value={word}>
                    {t(`tiers.label.${word}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasStoredOverride && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={mutation.isPending}
                onClick={() => save(null)}
              >
                {t('tiers.override.clear')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('tiers.override.help')}</p>
          {resolution.ignoredOverrideReason && (
            <p className="text-xs text-muted-foreground">{t('tiers.override.ignored')}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
