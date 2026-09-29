import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { COHORT_MIN_SIDE_GAMES, type Insight, type TierSplitCoverage } from '@smash-tracker/shared';
import { ClaimChip, type ClaimChipKind } from '@/components/analytics/ClaimChip';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { InsightCardErrorBoundary } from '@/components/analytics/InsightCardErrorBoundary';
import { UnlocksNext } from '@/components/analytics/UnlocksNext';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import { TierCoverageLine } from '@/components/analytics/tier/TierCoverageLine';
import { buildTierFilterSearch, readTierFilterParams } from '@/lib/tierFilterParams';

export interface TierInsightCardProps {
  /** The page's one `tierGap` computation (its `#games` terminus resolves the same object's `countedMatchIds`). */
  insight: Insight;
  /** The coverage the by-tier split reports for the same rows: how much history the read covers. */
  coverage: TierSplitCoverage;
  onDismiss: () => void;
}

/** The tier words the "Show these events" door filters to: cohort A, "majors and above". */
const COHORT_A_TIERS = ['supermajor', 'major'] as const;

/** The Tournaments page is personal-only, so the (unused) fallback-door path needs no subject prefix. */
function samePath(personalPath: string): string {
  return personalPath;
}

function claimChipKindFor(kind: Insight['kind']): ClaimChipKind {
  return kind === 'inference' ? 'trend' : 'fact';
}

/**
 * The evidence sentence: both records and the sample-size cue of the SMALLER
 * cohort, because a comparison is only as sure as its thinner side.
 */
function buildEvidence(insight: Insight, t: TFunction): string {
  const { aRecord, bRecord, aGames, bGames } = insight.copy.values;
  const thinner = Number(aGames) <= Number(bGames) ? insight.recent : insight.baseline;
  const cue =
    thinner.kind === 'evidenced' && thinner.sample.confidenceTier
      ? t(`shared.evidence.sampleCueGlyph.${thinner.sample.confidenceTier}`, {
          count: thinner.value.total,
        })
      : '';
  return t('insights.tierGap.evidence', { aRecord, bRecord, cue });
}

function TierInsightBody({ insight, coverage, onDismiss }: TierInsightCardProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const filters = readTierFilterParams(searchParams);

  const verdict = t(insight.copy.key, insight.copy.values);
  const name = t('tiers.filter.tierLabel');
  const coverageLine = <TierCoverageLine coverage={coverage} />;

  // The locked (abstained) form: a meter toward the cohort floor, no doors.
  if (insight.state === 'locked') {
    const have = Number(insight.copy.values.count);
    const need = COHORT_MIN_SIDE_GAMES;
    const lockedChipLabel = t('insights.kind.unlocksNext');
    const countLabel = t('insights.state.lockedMeter', { have, need });
    return (
      <div className="flex flex-col gap-3">
        <UnlocksNext
          chip={<ClaimChip locked kind="fact" label={lockedChipLabel} />}
          name={name}
          meters={[{ sentence: verdict, have, need, countLabel }]}
        />
        {coverageLine}
      </div>
    );
  }

  const chipKind = claimChipKindFor(insight.kind);
  const chipLabel = t(`insights.kind.${chipKind}`);
  const asserted = insight.state === 'trend' || insight.state === 'steady';
  const evidence = asserted ? buildEvidence(insight, t) : '';
  const estimated = Number(insight.copy.values.estimatedEvents);
  const estimatedNote =
    asserted && estimated > 0 ? t('insights.tierGap.estimatedNote', { count: estimated }) : null;
  const dismissLabel = t('insights.rail.dismiss');
  const seeGamesLabel = t('insights.door.seeGames', {
    count: insight.countedMatchIds.length,
  });
  const showEventsLabel = t('insights.door.showEvents');

  // The counted-games door carries the page's own tier / setting / side filters
  // (never a drill axis), so following it lands on the same cohort and the same
  // claim id, exactly the games this card counted.
  const gamesDoor = buildInsightDoors({
    insight,
    subjectPath: samePath,
    carry: buildTierFilterSearch(filters),
  }).find((door) => door.kind === 'games');
  const showEventsSearch = buildTierFilterSearch({
    tiers: [...COHORT_A_TIERS],
    ...(filters.setting != null ? { setting: filters.setting } : {}),
    ...(filters.side != null ? { side: filters.side } : {}),
  });

  const doorNodes = [
    gamesDoor ? (
      <Link key="games" to={gamesDoor.href}>
        {seeGamesLabel}
      </Link>
    ) : null,
    asserted ? (
      <Link key="events" to={`?${showEventsSearch.toString()}`}>
        {showEventsLabel}
      </Link>
    ) : null,
  ].filter((node) => node !== null);
  const doors: InsightCardDoors =
    doorNodes.length >= 2
      ? [doorNodes[0]!, doorNodes[1]!]
      : doorNodes.length === 1
        ? [doorNodes[0]!]
        : [];

  return (
    <InsightCard
      chip={<ClaimChip kind={chipKind} label={chipLabel} />}
      name={name}
      verdict={verdict}
      evidence={evidence}
      mark={coverageLine}
      sub={estimatedNote != null ? <span>{estimatedNote}</span> : undefined}
      doors={doors}
      onDismiss={onDismiss}
      dismissLabel={dismissLabel}
    />
  );
}

/**
 * The `tierGap` card (TIER-03, UI-SPEC 7.5): the Tournaments page's tier
 * insight, sitting beside the By-tier card. It renders its own locked form
 * through `UnlocksNext`, imported HERE and never from a file under
 * `pages/Tournaments/` (DD-13). A render failure removes the card via the
 * shared boundary, which logs the template id and nothing else.
 */
export function TierInsightCard(props: TierInsightCardProps) {
  return (
    <div data-slot="tier-insight-card">
      <InsightCardErrorBoundary templateId={props.insight.templateId} onError={noop}>
        <TierInsightBody {...props} />
      </InsightCardErrorBoundary>
    </div>
  );
}

function noop(): void {
  // A crash is not a preference: nothing to promote and nothing to dismiss.
}
