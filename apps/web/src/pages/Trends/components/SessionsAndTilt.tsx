import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';
import { Record } from '@/components/analytics/Record';
import { BoundedList, LIST_CAP_RAIL } from '@/components/analytics/BoundedList';
import { getSessions, type SessionStats } from '@/lib/stats';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { sortMatchesNewestFirst, type DrillDownAxes } from '@/lib/drillDownParams';

/** Loss runs at or above this length are called out in the recent-sessions list. */
export const TILT_HIGHLIGHT_THRESHOLD = 3;

export interface SessionsHeadline {
  totalSessions: number;
  /** Average games per session, rounded to 1 decimal. 0 when there are no sessions. */
  avgGamesPerSession: number;
  /** The session with the best net wins (wins - losses); null when there are no sessions. */
  bestSession: SessionStats | null;
  /** The session containing the single longest intra-session loss run ("worst tilt"); null when there are no sessions or no losses at all. */
  worstTiltSession: SessionStats | null;
}

/**
 * Headline stats for the sessions section. Exported as a pure builder so the
 * "best session" / "worst tilt" tie-break math can be unit-tested without
 * rendering. Ties for best session break toward the earliest session (stable
 * sort over `getSessions`' chronological order); ties for worst tilt do the
 * same.
 */
export function buildSessionsHeadline(sessions: SessionStats[]): SessionsHeadline {
  if (sessions.length === 0) {
    return { totalSessions: 0, avgGamesPerSession: 0, bestSession: null, worstTiltSession: null };
  }

  const totalGames = sessions.reduce((sum, s) => sum + s.total, 0);
  const avgGamesPerSession = Math.round((totalGames / sessions.length) * 10) / 10;

  const bestSession = sessions.reduce((best, session) => {
    const bestNet = best.wins - best.losses;
    const net = session.wins - session.losses;
    return net > bestNet ? session : best;
  }, sessions[0]!);

  const maxLossRun = Math.max(...sessions.map((s) => s.longestLossRun));
  const worstTiltSession =
    maxLossRun > 0 ? (sessions.find((s) => s.longestLossRun === maxLossRun) ?? null) : null;

  return { totalSessions: sessions.length, avgGamesPerSession, bestSession, worstTiltSession };
}

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDuration(session: SessionStats, t: TFunction): string {
  const ms = session.end - session.start;
  if (ms <= 0) return t('trends.sessions.durationUnderMin');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('trends.sessions.durationMin', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0
    ? t('trends.sessions.durationHM', { hours, minutes: remaining })
    : t('trends.sessions.durationH', { hours });
}

interface SessionRowProps {
  session: SessionStats;
  isExpanded: boolean;
  onToggle: () => void;
  sortedMatches: Match[];
  axes: DrillDownAxes;
  locale: string;
  t: TFunction;
}

function SessionRow({
  session,
  isExpanded,
  onToggle,
  sortedMatches,
  axes,
  locale,
  t,
}: SessionRowProps) {
  const dateLabel = formatDate(session.start, locale);
  return (
    <li className="flex flex-col gap-2 rounded-md p-2 hover:bg-accent">
      <div className="relative flex items-center gap-2">
        <DrillableRow
          as="overlay"
          onActivate={onToggle}
          expanded={isExpanded}
          ariaLabel={t('shared.drillableRow.aria', {
            subject: dateLabel,
            context: t('trends.sessions.title'),
          })}
        />
        <span className="min-w-0 flex-1 truncate">{dateLabel}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(session, t)}
        </span>
        <Record wins={session.wins} losses={session.losses} cue="none" />
        {session.longestLossRun >= TILT_HIGHLIGHT_THRESHOLD && (
          <span className="shrink-0 text-xs font-medium text-destructive tabular-nums">
            {t('trends.sessions.tiltRun', { count: session.longestLossRun })}
          </span>
        )}
        <DrillableRowChevron />
      </div>
      {isExpanded && <FilteredMatchList matches={sortedMatches} axes={axes} />}
    </li>
  );
}

export interface SessionsAndTiltProps {
  matches: Match[];
}

/**
 * The left rail's first card (UI-SPEC §8.2 Row 3): a 2×2 `StatRow`
 * (Sessions · Avg games · Best session + date · Longest loss run + date),
 * then recent session rows on the `BoundedList` primitive (cap
 * `LIST_CAP_RAIL`, inline expansion, terminus). "Tilt" = the longest
 * intra-session loss streak. Rows navigate with the session's `from`/`to`
 * axes, unchanged from Phase 38 (this plan changes the container and the
 * idiom, not the destinations).
 */
export function SessionsAndTilt({ matches }: SessionsAndTiltProps) {
  const { t, i18n } = useTranslation();
  const sessions = useMemo(() => getSessions(matches), [matches]);
  const headline = useMemo(() => buildSessionsHeadline(sessions), [sessions]);
  const recentSessions = useMemo(() => [...sessions].reverse(), [sessions]);
  // Phase 38-07 (D-14): a session row toggles an inline `FilteredMatchList`
  // for that session's inclusive start-to-end window — single-open, keyed on
  // the session's own `start` (unique per session per `getSessions`).
  const [expandedStart, setExpandedStart] = useState<number | null>(null);
  const sortedMatches = useMemo(() => sortMatchesNewestFirst(matches), [matches]);
  // WR-03 (38-REVIEW-FIX): one stable `{ from, to }` object PER session,
  // built once per `recentSessions` change — never a fresh object literal
  // per render inside the row map below.
  const axesBySessionStart = useMemo(() => {
    const map = new Map<number, DrillDownAxes>();
    for (const s of recentSessions) {
      map.set(s.start, { from: s.start, to: s.end });
    }
    return map;
  }, [recentSessions]);

  const empty = <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('trends.sessions.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sessions.length === 0 ? (
          empty
        ) : (
          <>
            <StatRow
              figures={[
                <StatFigure
                  key="total"
                  label={t('trends.sessions.total')}
                  value={`${headline.totalSessions}`}
                />,
                <StatFigure
                  key="avg"
                  label={t('trends.sessions.avgGames')}
                  value={`${headline.avgGamesPerSession}`}
                />,
                headline.bestSession ? (
                  <StatFigure
                    key="best"
                    label={t('trends.sessions.best')}
                    value={`${headline.bestSession.wins}-${headline.bestSession.losses}`}
                    support={formatDate(headline.bestSession.start, i18n.language)}
                  />
                ) : (
                  <StatFigure key="best" label={t('trends.sessions.best')} state="empty" />
                ),
                headline.worstTiltSession ? (
                  <StatFigure
                    key="worstTilt"
                    label={t('trends.sessions.worstTilt')}
                    value={t('trends.sessions.tiltRun', {
                      count: headline.worstTiltSession.longestLossRun,
                    })}
                    support={formatDate(headline.worstTiltSession.start, i18n.language)}
                  />
                ) : (
                  <StatFigure
                    key="worstTilt"
                    label={t('trends.sessions.worstTilt')}
                    state="empty"
                  />
                ),
              ]}
            />

            <BoundedList
              cap={LIST_CAP_RAIL}
              rows={recentSessions.map((session) => (
                <SessionRow
                  key={session.start}
                  session={session}
                  isExpanded={expandedStart === session.start}
                  onToggle={() =>
                    setExpandedStart(expandedStart === session.start ? null : session.start)
                  }
                  sortedMatches={sortedMatches}
                  axes={axesBySessionStart.get(session.start) ?? {}}
                  locale={i18n.language}
                  t={t}
                />
              ))}
              labels={{
                showAll: t('analytics.list.showAll', { count: recentSessions.length }),
                showFewer: t('analytics.list.showFewer'),
                showMore: t('analytics.list.showMore50'),
                terminus: t('analytics.list.allSessions', { count: recentSessions.length }),
              }}
              empty={empty}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
