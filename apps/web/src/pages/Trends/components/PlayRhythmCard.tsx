import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Insight } from '@smash-tracker/shared';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { InsightCard, type InsightCardDoors } from '@/components/analytics/InsightCard';
import { InsightCardErrorBoundary } from '@/components/analytics/InsightCardErrorBoundary';
import { UnlocksNext } from '@/components/analytics/UnlocksNext';
import { buildInsightDoors } from '@/components/analytics/insightDoors';
import { buildPlayRhythmEvidence, buildPlayRhythmVerdict } from '../lib/useTrendsCardInsights';

export interface PlayRhythmCardProps {
  /** The page's one `playRhythm` computation: its `#games` terminus resolves the same object's `countedMatchIds`. */
  insight: Insight;
  /** Dismisses the card through the page's one dismissal store (a locked card has nothing to dismiss). */
  onDismiss: () => void;
}

/** Trends is own-account only (38 D-04), so the (unused) fallback-door path needs no subject prefix. */
function samePath(personalPath: string): string {
  return personalPath;
}

function PlayRhythmBody({ insight, onDismiss }: PlayRhythmCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const name = t('trends.rhythm.title');
  const verdict = buildPlayRhythmVerdict(insight, t, locale);

  // The locked form: one meter toward the 12-month floor, no doors, no dismiss.
  if (insight.state === 'locked') {
    const have = Number(insight.copy.values.have);
    const need = Number(insight.copy.values.need);
    return (
      <UnlocksNext
        chip={<ClaimChip locked kind="fact" label={t('insights.kind.unlocksNext')} />}
        name={name}
        meters={[
          {
            sentence: verdict,
            have,
            need,
            countLabel: t('insights.playRhythm.lockedMeter', { have, need }),
          },
        ]}
      />
    );
  }

  const gamesDoor = buildInsightDoors({ insight, subjectPath: samePath }).find(
    (door) => door.kind === 'games',
  );
  const doors: InsightCardDoors = gamesDoor
    ? [
        <Link key="games" to={gamesDoor.href}>
          {t('insights.door.seeGames', { count: gamesDoor.count })}
        </Link>,
      ]
    : [];

  return (
    <InsightCard
      chip={<ClaimChip kind="fact" label={t('insights.kind.fact')} />}
      name={name}
      verdict={verdict}
      evidence={buildPlayRhythmEvidence(insight, t, locale)}
      doors={doors}
      onDismiss={onDismiss}
      dismissLabel={t('insights.rail.dismiss')}
    />
  );
}

/**
 * The `PlayRhythm` card (B1, DD-41-07, UI-SPEC 7.11): the 4-col read beside the activity heat. A FACT
 * (never a direction), its counted-games door the only filled button, a locked form that is one
 * `UnlocksNext` meter in months. A render failure removes this card only; the shared boundary logs the
 * closed template id and nothing else.
 */
export function PlayRhythmCard(props: PlayRhythmCardProps) {
  return (
    <div data-slot="play-rhythm-card">
      <InsightCardErrorBoundary templateId={props.insight.templateId} onError={noop}>
        <PlayRhythmBody {...props} />
      </InsightCardErrorBoundary>
    </div>
  );
}

function noop(): void {
  // A crash is not a preference: nothing to promote and nothing to dismiss.
}
