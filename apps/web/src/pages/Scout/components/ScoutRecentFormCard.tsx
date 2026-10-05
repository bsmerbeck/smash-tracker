import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { ChartCard } from '@/components/charts/ChartCard';
import { TrendLine, type TrendEventPoint } from '@/components/charts/TrendLine';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { localizedFighterName } from '@/lib/fighterNames';
import { formatDate, formatDaySpan } from '@/lib/format';
import { buildEventTrendPoints, readableEventLabel } from '@/lib/eventTrendPoints';
import { buildScoutFormSeries, gamesBehindPoint } from '../lib/fullAnalysis';

/**
 * Every row item but the last ends with a CSS middot separator — never JSX
 * text between two t() calls. Trailing (not leading), so a wrapped line never
 * starts with a separator. Same string as `CareerTimelineCard`'s caption.
 */
const CAPTION_ITEM_CLASSES =
  "[&:not(:last-child)]:after:mx-1.5 [&:not(:last-child)]:after:content-['·']";

/** A scouted fighter id of 0 (or an id with no localized name) reads as the unknown label. */
function fighterLabel(id: number, t: TFunction): string {
  const name = id === 0 ? '' : localizedFighterName(id, t);
  return name !== '' ? name : t('common.unknown');
}

function GameRow({ match }: { match: Match }) {
  const { t, i18n } = useTranslation();
  const stage = match.map && match.map.id !== 0 ? match.map.name : t('common.unknown');
  const items = [
    formatDate(match.time, i18n.language),
    match.opponent || t('common.unknown'),
    t('scout.fullAnalysis.form.characters', {
      fighter: fighterLabel(match.fighter_id, t),
      opponent: fighterLabel(match.opponent_id, t),
    }),
    stage,
    match.win ? t('common.win') : t('common.loss'),
  ];
  return (
    <li className="flex flex-wrap text-xs tabular-nums text-muted-foreground">
      {items.map((text, index) => (
        <span key={index} className={CAPTION_ITEM_CLASSES}>
          {text}
        </span>
      ))}
    </li>
  );
}

/**
 * Plan 41-12 (SC1 / SC2, PD-12-1 / PD-12-2): the Scout page's "Recent Form"
 * card. Plots the scouted player's whole sampled history as ONE event-anchored
 * cumulative series on the kit `TrendLine mode="event"` (at most 60 points,
 * `buildScoutFormSeries`) — no trailing window is computed anywhere on this
 * path — and any plotted point lists exactly its own games IN the card.
 *
 * PROVIDER-FREE on purpose (Phase 38 H-01 / H-02): scouted games are a THIRD
 * PARTY's history, with no row in the viewer's own match list, and this host
 * renders bare (no router, no query client, no subject context). The drill's
 * terminus is therefore the card's own games panel over the report payload
 * already in memory: buttons only, no anchor, no URL axis, no router API.
 * This is the second enumerated non-URL click, beside DD-41-12
 * (`chartKitBoundary.test.ts`, the kit README).
 *
 * A point's games are its `matchIds` (`gamesBehindPoint`) — identity, never a
 * time window. Every user-supplied string (tags, event names) renders as React
 * text.
 */
export function ScoutRecentFormCard({ matches, gamerTag }: { matches: Match[]; gamerTag: string }) {
  const { t, i18n } = useTranslation();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);

  const { display, grain } = useMemo(() => buildScoutFormSeries(matches), [matches]);
  const trendPoints = useMemo(
    () => buildEventTrendPoints({ series: display, opponentTag: '', t, locale: i18n.language }),
    [display, t, i18n.language],
  );

  // A stale key (the report changed under the card) resolves to nothing: no panel.
  const selected = useMemo(
    () =>
      selectedKey === null ? null : (display.find((point) => point.key === selectedKey) ?? null),
    [display, selectedKey],
  );
  const games = useMemo(
    () => (selected === null ? [] : gamesBehindPoint(selected, matches)),
    [selected, matches],
  );

  // Move focus to the panel heading on each NEW selection (pointer or keyboard).
  useEffect(() => {
    if (selectedKey !== null) {
      headingRef.current?.focus();
    }
  }, [selectedKey]);

  const handleSelectPoint = (point: TrendEventPoint) => setSelectedKey(point.eventKey);

  return (
    <ChartCard
      title={t('scout.fullAnalysis.recentForm', { name: gamerTag })}
      caption={t(`scout.fullAnalysis.form.caption.${grain}`)}
    >
      {trendPoints.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('opponents.trend.empty')}</p>
      ) : (
        <div
          className="flex flex-col gap-4"
          data-slot="scout-recent-form"
          data-points={trendPoints.length}
          data-grain={grain}
        >
          <TrendLine mode="event" points={trendPoints} onSelectPoint={handleSelectPoint} />
          {selected !== null && (
            <div
              className="flex flex-col gap-2 rounded-md bg-muted/40 p-3"
              data-slot="scout-form-games"
              data-count={games.length}
              data-point-key={selected.key}
            >
              <div className="flex items-start justify-between gap-2">
                <p ref={headingRef} tabIndex={-1} className="text-sm font-medium">
                  {t('scout.fullAnalysis.form.games', {
                    count: games.length,
                    event: readableEventLabel({ point: selected, t, locale: i18n.language }),
                    span: formatDaySpan(selected.startMs, selected.endMs, i18n.language),
                  })}
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className={MUTED_LINK_TONE}
                  onClick={() => setSelectedKey(null)}
                >
                  {t('scout.fullAnalysis.form.close')}
                </Button>
              </div>
              <BoundedList
                mode="full-page"
                cap={LIST_CAP}
                rows={games.map((match) => (
                  <GameRow key={match.id} match={match} />
                ))}
                labels={{
                  showAll: t('analytics.list.showAll', { count: games.length }),
                  showFewer: t('analytics.list.showFewer'),
                  showMore: t('analytics.list.showMore50'),
                  terminus: t('analytics.list.allGames', { count: games.length }),
                }}
                empty={null}
              />
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}
