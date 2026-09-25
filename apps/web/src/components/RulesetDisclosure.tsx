import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { ResolvedRuleset } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The ruleset DISCLOSURE control (EVID-04, D-10, D-16, D-18 — plan 37-05).
 * This is a disclosure and never an editor: it offers no way to change the
 * ruleset — override editing lives on tournament detail
 * (`RulesetOverrideSection`, plan 37-04). It reuses that component's exact
 * detail-line keys (`shared.ruleset.preset.*`) rather than paraphrasing a
 * second vocabulary.
 *
 * On Matchups (this plan's only mount point) the resolved source is ALWAYS
 * the house default this phase: Matchups is not event-scoped, and D-18 keeps
 * tournaments own-account only, so no per-tournament ruleset is wired onto a
 * fighter-pairing surface yet. The event-override badge path below is
 * implemented and unit-tested here (`resolveRuleset`'s `event-override`
 * source is a real, reachable value from any caller), but it does not fire
 * on Matchups — the event-override STATE renders on tournament detail
 * instead (`RulesetOverrideSection`).
 */
export function RulesetDisclosure({ resolved }: { resolved: ResolvedRuleset }) {
  const { t } = useTranslation();
  const { ruleset } = resolved;
  const isOverride = resolved.source === 'event-override';
  const presetName = isOverride
    ? t('shared.ruleset.customName')
    : t('shared.ruleset.preset.default.name');

  const starterClause = t('shared.ruleset.preset.starterClause', {
    count: ruleset.starterStageIds.length,
  });
  const banClause = t('shared.ruleset.preset.banClause', {
    count: ruleset.banCounts[ruleset.setFormat.default],
  });
  const dsrLabel = t(`shared.ruleset.dsr.${ruleset.dsr}`);
  const setFormatLabel = t(`shared.ruleset.setFormat.${ruleset.setFormat.default}`);
  const detailLine = t('shared.ruleset.preset.default.detail', {
    starters: starterClause,
    bans: banClause,
    strikeOrder: ruleset.strikeOrder,
    dsr: dsrLabel,
    setFormat: setFormatLabel,
    source: ruleset.source.url,
    date: ruleset.source.retrievedAt,
  });

  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('shared.ruleset.control.aria')}
          >
            {t('shared.ruleset.control.label', { preset: presetName })}
            <ChevronDown className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 text-sm">
          <PopoverHeader>
            <PopoverTitle>{presetName}</PopoverTitle>
            <p className="text-muted-foreground">{detailLine}</p>
            {isOverride && <p>{t('shared.ruleset.overrideEditHint')}</p>}
            {resolved.ignoredOverrideReason && (
              <p className="text-xs text-muted-foreground">{t('shared.ruleset.overrideIgnored')}</p>
            )}
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      {isOverride && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline">{t('shared.ruleset.overrideBadge')}</Badge>
          </TooltipTrigger>
          <TooltipContent>
            {ruleset.source.url} · {ruleset.source.retrievedAt}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
