import type { TFunction } from 'i18next';
import type { Insight, InsightState, InsightTemplateId } from '@smash-tracker/shared';
import { formatPercent } from '@/lib/formatPercent';

/** RED stub (plan 39.1-52): the shape vocabulary, with every template still on the horizon line. */
export type EvidenceShape = 'horizon' | 'lifetime' | 'event' | 'host';

export const EVIDENCE_SHAPE_DEFAULT: Record<InsightTemplateId, EvidenceShape> = {
  formNow: 'horizon',
  characterMovers: 'horizon',
  rivalMovers: 'horizon',
  lastEventRecap: 'horizon',
  ratingMove: 'horizon',
  tiltCost: 'horizon',
  sessionFatigue: 'horizon',
  settingGap: 'horizon',
  volumeForm: 'horizon',
  mixShift: 'horizon',
  rosterCore: 'horizon',
  rosterShift: 'horizon',
  secondaryPayoff: 'horizon',
  pocketCost: 'horizon',
  matchupOrPlayer: 'horizon',
  bestMatchup: 'horizon',
  worstMatchup: 'horizon',
  tierGap: 'horizon',
  playRhythm: 'horizon',
};

export const EVIDENCE_SHAPE_BY_STATE: Partial<
  Record<InsightTemplateId, Partial<Record<InsightState, EvidenceShape>>>
> = {};

export function resolveEvidenceShape(_insight: Insight): EvidenceShape {
  return 'horizon';
}

/** RED stub: MatchDataRail's twoHorizon composition, verbatim. */
export function buildInsightEvidenceLine(
  insight: Insight,
  t: TFunction,
  locale: string,
  _opts?: { cueCount?: number },
): string | null {
  const claim = insight.recent;
  if (claim.kind !== 'evidenced') {
    return '';
  }
  const record = `${claim.value.wins}–${claim.value.losses}`;
  const rate = formatPercent(claim.value.rate, locale);
  const tier = claim.sample.confidenceTier;
  const cue = tier ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: claim.value.total }) : '';
  const baselineClaim = insight.baseline;
  const baselineRate =
    baselineClaim.kind === 'evidenced' ? formatPercent(baselineClaim.value.rate, locale) : '';
  const baselineGames = baselineClaim.kind === 'evidenced' ? baselineClaim.value.total : 0;
  return t(`insights.evidence.twoHorizon.${insight.horizon}`, {
    recentRecord: `${record} · ${rate}`,
    baselineRate,
    baselineGames,
    cue,
  });
}
