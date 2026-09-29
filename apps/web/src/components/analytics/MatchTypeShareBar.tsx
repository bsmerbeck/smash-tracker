import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { classify, resolveWindow, toRateValue } from '@smash-tracker/shared';
import { ShareBar, type ShareBarSegment } from '@/components/charts/inlineMarks';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { Record } from '@/components/analytics/Record';
import { getMatchTypeRecords } from '@/lib/stats';

/**
 * `getMatchTypeRecords`'s own grouping rule (apps/web/src/lib/stats.ts): a
 * missing, '' or 'none' match type folds into 'unspecified'. The per-type
 * recent windows below MUST partition `matches` by the same rule, or a row's
 * chip would speak for a different set of games than its record.
 */
function matchTypeKeyOf(match: Match): string {
  const raw = match.matchType ?? '';
  return raw === '' || raw === 'none' ? 'unspecified' : raw;
}

export interface MatchTypeShareBarProps {
  /** The hero's scoped base (a fighter's or a pairing's games). */
  matches: Match[];
  /** The page's ONE persisted horizon — every row's chip compares that window. */
  horizon: HorizonKey;
  /** The host's one clock (D-06 / D-12). */
  nowMs: number;
}

/**
 * Plan 39.1-43 (sketch 003 A "Hero port", sketch 001-C / 003 `shareBar` +
 * `shareSection`): the hero's by-match-type ShareBar under its "By match
 * type" overline. Plan 39.1-36 semantics, moved verbatim from the Fighter
 * hero: each row compares THAT type's recent window (the page horizon, D-15
 * scoped) with THAT type's own all-time rate — never the type against the
 * overall rate, which read "Steady" on zero recent games.
 */
export function MatchTypeShareBar({ matches, horizon, nowMs }: MatchTypeShareBarProps) {
  const { t } = useTranslation();

  const typeRows = useMemo(() => {
    const byType = new Map<string, Match[]>();
    for (const match of matches) {
      const key = matchTypeKeyOf(match);
      const group = byType.get(key);
      if (group) {
        group.push(match);
      } else {
        byType.set(key, [match]);
      }
    }
    return getMatchTypeRecords(matches).map((record) => {
      const typeMatches = byType.get(record.matchType) ?? [];
      const typeBaseline = toRateValue(typeMatches);
      const { matches: typeRecentMatches } = resolveWindow({
        matches: typeMatches,
        horizon,
        scoped: true,
        nowMs,
      });
      const typeRecent = toRateValue(typeRecentMatches);
      const { state, deltaPoints } = classify({
        recent: typeRecent,
        baseline: typeBaseline,
        scoped: true,
        hasAction: false,
      });
      return { record, typeRecent, typeBaseline, state, deltaPoints };
    });
  }, [matches, horizon, nowMs]);

  const segments: ShareBarSegment[] = typeRows.map(
    ({ record, typeRecent, typeBaseline, state, deltaPoints }) => {
      const key = record.matchType === 'unspecified' ? 'none' : record.matchType;
      const label = t(`analytics.matchType.${key}`, { defaultValue: record.matchType });
      // The header ("By match type") does not name the horizon, so the chip
      // carries it: "no games · last 30", "Steady · last 30".
      const chipView = deltaChipView({
        state,
        deltaPoints,
        recentGames: typeRecent.total,
        horizon,
        horizonOwnedByParent: false,
        t,
      });
      return {
        key: record.matchType,
        label,
        count: record.total,
        record: <Record wins={record.wins} losses={record.losses} cue="none" />,
        delta: chipView ? (
          <DeltaChip
            {...chipView}
            ariaLabel={t('analytics.dumbbell.rowAria', {
              label,
              recentRecord: `${typeRecent.wins}–${typeRecent.losses}`,
              baselineRecord: `${typeBaseline.wins}–${typeBaseline.losses}`,
            })}
          />
        ) : null,
      };
    },
  );

  // Resolved in separate statements (insightCopy guard: no two translation
  // calls inside one JSX expression).
  const emptyText = t('analytics.share.empty');
  const ariaSummary = t('analytics.share.aria', { count: matches.length });
  const headerText = t('analytics.share.byMatchType');

  return (
    <ShareBar
      segments={segments}
      total={matches.length}
      headerLabel={
        <span
          data-slot="match-type-share-overline"
          className="text-[0.6875rem] leading-4 font-semibold tracking-wider uppercase"
        >
          {headerText}
        </span>
      }
      shareSuffix={(pct) => `${pct}%`}
      emptyNode={emptyText}
      ariaSummary={ariaSummary}
    />
  );
}
