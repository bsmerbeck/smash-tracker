import { useTranslation } from 'react-i18next';
import { resolveRuleset, type TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRulesetOverride } from '@/hooks/useRulesetOverride';

export interface RulesetOverrideSectionProps {
  entry: Pick<TournamentEntry, 'entryKey' | 'rulesetOverride'>;
}

/**
 * Tournament-detail ruleset disclosure + edit entry point (EVID-04, D-10,
 * D-16). Renders for every entry including admin-imported ones (see
 * `TournamentDetailPage`'s mount comment): the retrospective in plan 37-06
 * grades historical picks under whichever ruleset applied to that event, and
 * this section is where that ruleset is disclosed and — own-account only,
 * D-18 — edited.
 *
 * The editor dialog itself lands in Task 3 of this plan; until then the edit
 * button opens nothing (a functionality gap, not an architectural one). The
 * reset control below already exercises the save path end to end with a
 * clearing PATCH, so the mutation wiring is proven by this task, not merely
 * stubbed.
 */
export function RulesetOverrideSection({ entry }: RulesetOverrideSectionProps) {
  const { t } = useTranslation();
  const entryKey = entry.entryKey ?? '';
  const mutation = useRulesetOverride(entryKey);
  const resolved = resolveRuleset(entry.rulesetOverride);
  const { ruleset } = resolved;
  const banCount = ruleset.banCounts[ruleset.setFormat.default];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tournaments.detail.rulesetOverride.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <p>
          {t(
            resolved.source === 'event-override'
              ? 'tournaments.detail.rulesetOverride.usingOverride'
              : 'tournaments.detail.rulesetOverride.usingDefault',
          )}
        </p>
        <p className="text-muted-foreground">
          {t('shared.ruleset.preset.starterClause', { count: ruleset.starterStageIds.length })}
          {', '}
          {t('shared.ruleset.preset.banClause', { count: banCount })}
          {', '}
          {t(`shared.ruleset.dsr.${ruleset.dsr}`)}
          {', '}
          {t(`shared.ruleset.setFormat.${ruleset.setFormat.default}`)}
        </p>
        {resolved.ignoredOverrideReason && (
          <p className="text-xs text-muted-foreground">{t('shared.ruleset.overrideIgnored')}</p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm">
            {t('tournaments.detail.rulesetOverride.editButton')}
          </Button>
          {resolved.source === 'event-override' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(null)}
            >
              {t('tournaments.detail.rulesetOverride.resetButton')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
