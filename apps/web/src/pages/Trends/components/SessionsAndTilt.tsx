import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getSessions, type SessionStats } from '@/lib/stats';

/** Loss runs at or above this length are highlighted in destructive tone in the recent-sessions table. */
export const TILT_HIGHLIGHT_THRESHOLD = 3;

/** How many of the most recent sessions to list in the table. */
const RECENT_SESSION_LIMIT = 10;

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

/**
 * V3 Phase F: session grouping (default gap from `getSessions`) with a
 * headline stats row and a recent-sessions table. "Tilt" = the longest
 * intra-session loss streak; the worst one across all sessions is called out
 * by date.
 */
export function SessionsAndTilt({ matches }: { matches: Match[] }) {
  const { t, i18n } = useTranslation();
  const sessions = getSessions(matches);
  const headline = buildSessionsHeadline(sessions);
  const recentSessions = [...sessions].reverse().slice(0, RECENT_SESSION_LIMIT);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('trends.sessions.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('common.noMatchData')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Headline label={t('trends.sessions.total')} value={headline.totalSessions} />
              <Headline label={t('trends.sessions.avgGames')} value={headline.avgGamesPerSession} />
              <Headline
                label={t('trends.sessions.best')}
                value={
                  headline.bestSession
                    ? `${headline.bestSession.wins}-${headline.bestSession.losses}`
                    : '—'
                }
                sub={
                  headline.bestSession
                    ? formatDate(headline.bestSession.start, i18n.language)
                    : undefined
                }
              />
              <Headline
                label={t('trends.sessions.worstTilt')}
                value={
                  headline.worstTiltSession
                    ? t('trends.sessions.tiltRun', {
                        count: headline.worstTiltSession.longestLossRun,
                      })
                    : '—'
                }
                sub={
                  headline.worstTiltSession
                    ? formatDate(headline.worstTiltSession.start, i18n.language)
                    : undefined
                }
                tone={headline.worstTiltSession ? 'destructive' : undefined}
              />
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('trends.sessions.date')}</TableHead>
                  <TableHead>{t('trends.sessions.duration')}</TableHead>
                  <TableHead>{t('trends.monthly.wl')}</TableHead>
                  <TableHead>{t('common.rate')}</TableHead>
                  <TableHead>{t('trends.sessions.lossRun')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSessions.map((session) => (
                  <TableRow key={session.start}>
                    <TableCell>{formatDate(session.start, i18n.language)}</TableCell>
                    <TableCell>{formatDuration(session, t)}</TableCell>
                    <TableCell>
                      {session.wins}-{session.losses}
                    </TableCell>
                    <TableCell>{session.winRate}%</TableCell>
                    <TableCell>
                      {session.longestLossRun >= TILT_HIGHLIGHT_THRESHOLD ? (
                        <Badge variant="destructive">{session.longestLossRun}</Badge>
                      ) : (
                        session.longestLossRun
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Headline({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'destructive';
}) {
  return (
    <div>
      <h3 className="text-sm text-muted-foreground">{label}</h3>
      <p className={`text-xl font-semibold ${tone === 'destructive' ? 'text-destructive' : ''}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
