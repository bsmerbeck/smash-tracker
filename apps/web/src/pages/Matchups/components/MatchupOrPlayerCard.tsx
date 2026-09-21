import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, InsightScope, Match } from '@smash-tracker/shared';
import { INSIGHT_TEMPLATES, confidenceTierFor } from '@smash-tracker/shared';
import { InsightCard } from '@/components/analytics/InsightCard';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { localizedFighterName } from '@/lib/fighterNames';
import { claimChipKindFor } from './MatchupChart';

const MATCHUP_OR_PLAYER_TEMPLATE = INSIGHT_TEMPLATES.find(
  (template) => template.id === 'matchupOrPlayer',
)!;

/**
 * UI-SPEC §8.3/§9.4 (`MatchupOrPlayer`): a four-column `InsightCard` telling
 * the reader whether a bad matchup is player-driven (one opponent accounts
 * for a disproportionate share of the pairing's losses) or matchup-driven
 * (losses spread across the field). Renders NOTHING at all when the engine
 * reports the read `hidden` — not an empty card, not a locked card, because
 * `matchupOrPlayer.ts`'s own contract distinguishes those states (it never
 * emits a `locked` read for this template — see its SUMMARY's key-decisions).
 */
export function MatchupOrPlayerCard({
  matchupMatches,
  horizon,
}: {
  matchupMatches: Match[];
  horizon: HorizonKey;
}) {
  const { t } = useTranslation();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — the lazy `useState` initializer is this codebase's established
  // one-time-read escape hatch (see `MatchupChart.tsx`, `useHorizon.ts`).
  const [nowMs] = useState(() => Date.now());

  const fighterId = matchupMatches[0]?.fighter_id;
  const opponentId = matchupMatches[0]?.opponent_id;

  const insight = useMemo(() => {
    if (fighterId == null || opponentId == null) return null;
    const scope: InsightScope = {
      kind: 'character',
      key: `character:${fighterId}:${opponentId}`,
      axes: { fighter: fighterId, vs: opponentId },
      filter: (matches: Match[]) => matches,
    };
    const built = MATCHUP_OR_PLAYER_TEMPLATE.build({
      matches: matchupMatches,
      scope,
      horizon,
      nowMs,
    });
    return built[0] ?? null;
  }, [fighterId, opponentId, matchupMatches, horizon, nowMs]);

  if (!insight || insight.state === 'hidden' || opponentId == null) {
    return null;
  }

  const matchup = `${t('matchups.vs')} ${localizedFighterName(opponentId, t)}`;
  const chipKind = claimChipKindFor(insight.kind);
  const verdict = t(insight.copy.key, { ...insight.copy.values, matchup });

  const claim = insight.recent;
  const record = claim.kind === 'evidenced' ? claim.value : null;
  const tier = record ? confidenceTierFor(record.total) : null;
  const cue = tier
    ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: record?.total ?? 0 })
    : '';
  const evidence = record
    ? t('insights.evidence.single', { record: `${record.wins}–${record.losses}`, cue })
    : '';

  return (
    <InsightCard
      chip={<ClaimChip kind={chipKind} label={t(`insights.kind.${chipKind}`)} />}
      name={matchup}
      verdict={verdict}
      evidence={evidence}
    />
  );
}
