import { useTranslation } from 'react-i18next';
import { DEFAULT_RULESET, type ResolvedRuleset } from '@smash-tracker/shared';
import { getStageById } from '@/data/stages';

function stageNames(ids: readonly number[]): string {
  return ids.map((id) => getStageById(id)?.name ?? String(id)).join(', ');
}

/**
 * The ONE structured ruleset body (EVID-04, plan 37-07) rendered by both the
 * Matchups ruleset popover (`RulesetDisclosure`) and the tournament-detail
 * ruleset card (`RulesetOverrideSection`), so the two surfaces can never
 * drift. Each member sits on its own labelled row — the stored strike order
 * is a full sentence, so it is never interpolated into another sentence
 * (UAT 37-4 / F10). Stage names stay untranslated, as everywhere else.
 * No row names a tournament organiser's official ruleset (D-17).
 */
export function RulesetDetailList({ resolved }: { resolved: ResolvedRuleset }) {
  const { t } = useTranslation();
  const { ruleset } = resolved;
  const isOverride = resolved.source === 'event-override';

  const counterpicks =
    ruleset.counterpickStageIds.length > 0
      ? stageNames(ruleset.counterpickStageIds)
      : t('shared.ruleset.rows.none');
  const bans = [
    `${t('shared.ruleset.setFormat.bo3')}: ${t('shared.ruleset.preset.banClause', { count: ruleset.banCounts.bo3 })}`,
    `${t('shared.ruleset.setFormat.bo5')}: ${t('shared.ruleset.preset.banClause', { count: ruleset.banCounts.bo5 })}`,
  ].join(' · ');
  const strikeOrder =
    ruleset.strikeOrder === DEFAULT_RULESET.strikeOrder
      ? t('shared.ruleset.preset.default.strikeOrder')
      : ruleset.strikeOrder;
  const setFormat = t('shared.ruleset.rows.setFormatValue', {
    default: t(`shared.ruleset.setFormat.${ruleset.setFormat.default}`),
    topCut: t(`shared.ruleset.setFormat.${ruleset.setFormat.topCut}`),
  });

  const rows: Array<{ key: string; label: string; value: string }> = [
    {
      key: 'starters',
      label: t('shared.ruleset.rows.starters'),
      value: stageNames(ruleset.starterStageIds),
    },
    { key: 'counterpicks', label: t('shared.ruleset.rows.counterpicks'), value: counterpicks },
    { key: 'bans', label: t('shared.ruleset.rows.bans'), value: bans },
    {
      key: 'dsr',
      label: t('shared.ruleset.rows.dsr'),
      value: t(`shared.ruleset.dsr.${ruleset.dsr}`),
    },
    { key: 'strikeOrder', label: t('shared.ruleset.rows.strikeOrder'), value: strikeOrder },
    { key: 'setFormat', label: t('shared.ruleset.rows.setFormat'), value: setFormat },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-2 text-muted-foreground">
      <dl className="grid min-w-0 gap-1.5">
        {rows.map((row) => (
          <div key={row.key} className="min-w-0">
            <dt className="text-xs font-medium text-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="min-w-0 break-words text-xs">
        {isOverride
          ? t('shared.ruleset.sourceCustom')
          : t('shared.ruleset.sourceHouse', {
              source: ruleset.source.url,
              date: ruleset.source.retrievedAt,
            })}
      </p>
    </div>
  );
}
