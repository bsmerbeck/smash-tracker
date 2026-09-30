import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ACCOUNT_SCOPE,
  buildEventHorizonRead,
  buildLastEventRecapInsight,
  readSetStripMark,
  type HorizonKey,
  type Insight,
  type Match,
  type TierResolution,
} from '@smash-tracker/shared';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { InsightCardErrorBoundary } from '@/components/analytics/InsightCardErrorBoundary';
import { deltaChipView } from '@/components/analytics/deltaChipView';
import { TierBadge } from '@/components/analytics/tier/TierBadge';
import { TierProvenanceLine } from '@/components/analytics/tier/TierProvenanceLine';
import { buildGamesDoorHref } from '@/components/analytics/track/recapGamesDoor';
import { useTierProvenanceText } from '@/components/analytics/tier/tierProvenance';
import { SetStrip } from '@/components/charts/FormStrip';
import { usePrepBrief } from '@/hooks/usePrepBrief';
import type { RecapCandidate, RecapCandidateResult } from '@/hooks/useRecapCandidate';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { formatPercent } from '@/lib/formatPercent';
import { isDebriefWindowOpen } from '@/lib/prepEntryPoints';

export interface RecapCardProps {
  /** The one candidate the Dashboard shares with the prep slot (DD-07). */
  recap: RecapCandidateResult;
  /** Every game of the subject: the "all time" side of the event's two-horizon read. */
  allMatches: Match[];
  /**
   * 39.2-REVIEW WEB-WR-03: the games Match Data lists — the subject's games with the global
   * source and range filter applied (`useFilteredMatches().matches`) — so the games door's
   * printed count is checked against the rows its destination will actually show.
   */
  terminusMatches: Match[];
  /** The page horizon, which names the insight's id (`lastEventRecap:account:<horizon>`). */
  horizon: HorizonKey;
}

/** The badge and its provenance line read ONE resolution, so the word and the basis can never disagree. */
function RecapTier({ resolution }: { resolution: TierResolution }) {
  const provenance = useTierProvenanceText(resolution) ?? '';
  return (
    <div data-slot="recap-tier" className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge
          tier={resolution.tier}
          basis={resolution.basis}
          source={resolution.source}
          provenance={provenance}
        />
      </div>
      <TierProvenanceLine resolution={resolution} />
    </div>
  );
}

function buildSetStrip(insight: Insight, t: TFunction): ReactNode {
  const data = readSetStripMark(insight.mark);
  if (data === null) return null;
  const won = data.sets.filter((set) => set.won).length;
  const ariaLabel = t('insights.mark.setStrip', {
    count: data.sets.length,
    won,
    lost: data.sets.length - won,
  });
  return (
    <div className="flex items-center" data-slot="recap-set-strip">
      <SetStrip
        ariaLabel={ariaLabel}
        sets={data.sets.map((set) => {
          const record = `${set.gamesWon}–${set.gamesLost}`;
          return {
            key: set.setId,
            won: set.won,
            label:
              set.opponentName === null
                ? t('insights.mark.setTickNoOpponent', { record })
                : t('insights.mark.setTick', { opponent: set.opponentName, record }),
          };
        })}
      />
    </div>
  );
}

function RecapCardBody({
  candidate,
  allMatches,
  terminusMatches,
  horizon,
  onDismiss,
}: {
  candidate: RecapCandidate;
  allMatches: Match[];
  terminusMatches: Match[];
  horizon: HorizonKey;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  // One clock per card: the insight's refresh stamp and the debrief window's "now".
  const [nowMs] = useState(() => Date.now());
  const { entry } = candidate;

  const insight = useMemo(
    () =>
      buildLastEventRecapInsight({
        matches: candidate.games,
        scope: ACCOUNT_SCOPE,
        horizon,
        nowMs,
        registryEntry: entry?.entry,
        tier: entry ? { tier: entry.resolution.tier, basis: entry.resolution.basis } : undefined,
      }),
    [candidate.games, horizon, nowMs, entry],
  );
  const read = useMemo(
    () => buildEventHorizonRead({ eventMatches: candidate.games, baselineMatches: allMatches }),
    [candidate.games, allMatches],
  );

  // Own-account, non-imported, routable entry only: the one place a debrief door can exist (D-11).
  const debriefKey = entry && !entry.isAdminImported && entry.entryKey ? entry.entryKey : undefined;
  const prepStatus = usePrepBrief(debriefKey);
  // Pending or failed is unknown: never a door the settled render would retract (D-18).
  const debriefOpen =
    debriefKey !== undefined && prepStatus.isSuccess && isDebriefWindowOpen(prepStatus.data, nowMs);

  if (insight.state === 'hidden') return null;

  const numbers = new Intl.NumberFormat(i18n.language);
  const placement = insight.copy.values.placement;
  const entrants = insight.copy.values.entrants;
  const verdictValues: Record<string, string | number> = {
    ...insight.copy.values,
    event: entry?.entry.tournamentName ?? candidate.eventKey,
  };
  if (typeof placement === 'number' && typeof entrants === 'number') {
    verdictValues.placement = t('tournaments.table.placement', { count: placement, ordinal: true });
    verdictValues.entrants = numbers.format(entrants);
  }
  const verdict = t(insight.copy.key, verdictValues);

  const claim = insight.recent;
  const tierCue = claim.kind === 'evidenced' ? claim.sample.confidenceTier : undefined;
  const cue =
    claim.kind === 'evidenced' && tierCue
      ? t(`shared.evidence.sampleCueGlyph.${tierCue}`, { count: claim.value.total })
      : '';
  const evidence = t('insights.lastEventRecap.evidence', {
    eventRecord: String(insight.copy.values.gameRecord),
    baselineRate: formatPercent(read.baseline.rate, i18n.language),
    baselineGames: read.baseline.total,
    cue,
  });

  const chip = deltaChipView({
    state: read.state,
    deltaPoints: read.deltaPoints,
    recentGames: read.recent.total,
    horizon: 'lastEvent',
    horizonOwnedByParent: false,
    t,
  });
  const chipAria = t('analytics.dumbbell.rowAria', {
    label: candidate.eventKey,
    recentRecord: `${read.recent.wins}–${read.recent.losses}`,
    baselineRecord: `${read.baseline.wins}–${read.baseline.losses}`,
  });

  const subLineKey = insight.copy.values.subLineKey;
  const sub = typeof subLineKey === 'string' ? t(subLineKey, insight.copy.values) : undefined;

  // Doors (DD-06): the debrief door leads only when the server says the debrief is open; the
  // games door is then second. Without it the games door is first and so the primary.
  //
  // The games door lands on Match Data's games terminus through the drill-down contract's
  // inclusive date window over the event's first and last game (`buildDrillDownSearch`, the ONE
  // search builder). `buildInsightDoors`' own `?claim=` href is same-route and query-only: the
  // Dashboard has no terminus to resolve it, and the Trends host that could is personal-only,
  // so a coach's card would land on the VIEWER's data. Match Data is mounted under every
  // subject family. Same-n (DD-06): the door prints the event's game count, so it is offered
  // only when that window holds exactly those games; a stray game inside it drops the door
  // rather than promising a count the terminus would not show.
  // WEB-WR-03: checked against Match Data's own (source- and range-filtered) population.
  const gamesDoorHref = buildGamesDoorHref(candidate.games, terminusMatches, subjectPath);
  const doorNodes: ReactNode[] = [];
  if (debriefOpen && debriefKey) {
    const debriefLabel = t('insights.door.debrief');
    doorNodes.push(
      <Link key="debrief" to={`/tournaments/${debriefKey}/prep`}>
        {debriefLabel}
      </Link>,
    );
  }
  if (gamesDoorHref !== null) {
    const gamesLabel = t('insights.door.seeGames', { count: candidate.games.length });
    doorNodes.push(
      <Link key="games" to={gamesDoorHref}>
        {gamesLabel}
      </Link>,
    );
  }
  if (entry?.entryKey) {
    const openLabel = t('insights.door.openEvent');
    doorNodes.push(
      <Link key="event" to={`/tournaments/${entry.entryKey}`}>
        {openLabel}
      </Link>,
    );
  }
  const doors: InsightCardDoors =
    doorNodes.length >= 3
      ? [doorNodes[0]!, doorNodes[1]!, doorNodes[2]!]
      : doorNodes.length === 2
        ? [doorNodes[0]!, doorNodes[1]!]
        : doorNodes.length === 1
          ? [doorNodes[0]!]
          : [];

  const chipLabel = t('insights.kind.fact');
  const name = t('insights.horizon.lastEvent');
  const dismissLabel = t('insights.rail.dismiss');
  const setStrip = buildSetStrip(insight, t);

  const mark = (
    <div className="flex min-w-0 flex-col gap-3">
      {entry && <RecapTier resolution={entry.resolution} />}
      {chip && (
        <div data-slot="recap-chip" className="flex items-center">
          <DeltaChip {...chip} ariaLabel={chipAria} />
        </div>
      )}
      {setStrip}
    </div>
  );

  return (
    <InsightCard
      chip={<ClaimChip kind="fact" label={chipLabel} />}
      name={name}
      verdict={verdict}
      evidence={evidence}
      mark={mark}
      sub={sub ? <span>{sub}</span> : undefined}
      doors={doors}
      onDismiss={onDismiss}
      dismissLabel={dismissLabel}
    />
  );
}

/** A crash removes the card and nothing else; it is not a preference, so nothing is dismissed. */
function noop(): void {
  // Nothing to promote and nothing to dismiss.
}

/**
 * TRK-03 (UI-SPEC 7.10, D-09..D-12, D-17, D-18): the Dashboard's deterministic recap of the
 * subject's newest completed event, in the `InsightCard` frame. One engine: the verdict is 39.1's
 * `lastEventRecap` sentence (placement variant when the own-account registry has the event), the
 * chip is the engine's own `classify` of the event against all games (`thin` for a small event,
 * never an invented direction), and there is no call-out of a best win or worst loss. It renders
 * nothing when no candidate is due, so the Dashboard never shows an empty 4-column frame. Nothing
 * paid is reachable from here: no report or billing module is imported and no sparkle icon renders.
 */
export function RecapCard({ recap, allMatches, terminusMatches, horizon }: RecapCardProps) {
  const { t } = useTranslation();
  if (recap.status === 'loading') {
    return <CardSkeleton variant="list" rows={3} statusLabel={t('dashboard.loading')} />;
  }
  if (recap.status !== 'ready' || !recap.candidate) return null;
  return (
    <section data-slot="recap-card" aria-label={t('insights.horizon.lastEvent')}>
      <InsightCardErrorBoundary templateId="lastEventRecap" onError={noop}>
        <RecapCardBody
          candidate={recap.candidate}
          allMatches={allMatches}
          terminusMatches={terminusMatches}
          horizon={horizon}
          onDismiss={recap.dismiss}
        />
      </InsightCardErrorBoundary>
    </section>
  );
}
