import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react';
import type { TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useActiveSubject } from '@/hooks/useActiveSubject';
import { useOwnedWorkspaceSubject } from '@/hooks/useOwnedWorkspaceSubject';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { MAX_PREP_BRIEF_READS, usePrepBrief, usePrepBriefs } from '@/hooks/usePrepBrief';
import { isAdminImportedEntry } from '@/lib/historicalTournament';
import {
  findMostRecentPastEntry,
  formatEntryDate,
  isDebriefWindowOpen,
  listUpcomingEntries,
  type RoutableTournamentEntry,
} from '@/lib/prepEntryPoints';
import { resolveTournamentEntry, type TournamentBlock } from '@/pages/Opponents/tournamentHistory';

interface HubPrepBriefCardProps {
  /** The hub's RESOLVED opponent identity (the alias-chain hop already applied), never the raw path tag. */
  opponentIdentity: string;
  /** The display tag the copy interpolates. */
  opponentTag: string;
  /** The hub's own identity resolver — the ONE comparison every likely-opponent name goes through. */
  resolveOpponent: (match: { opponent: string }) => string;
  /** The hub's tournament blocks against this opponent — the events both players appear in. */
  tournamentBlocks: readonly TournamentBlock[];
}

type UpcomingResolution =
  { kind: 'unknown' } | { kind: 'none' } | { kind: 'found'; entry: RoutableTournamentEntry };

/**
 * Plan 39-12 (PREP-05, D-10/D-11/D-13): the opponent hub's FREE prep-brief
 * card. The exported symbol is a THIN GATE.
 *
 * D-10: prep and debrief entry points exist for the OWN-ACCOUNT subject only — this renders nothing under `/coach/:clientId/*` and `/workspace/:tenantId/*`.
 * `react-hooks/rules-of-hooks` is why this is a separate component and not a guard clause: every hook below lives in the inner component, so each stays unconditional.
 *
 * The two subject hooks are composed directly rather than through the
 * collapsing helper, which loses which prefix family produced the subject.
 * Under a coach or workspace route the inner component never mounts, so no
 * prep or tournament request is issued at all.
 */
export function HubPrepBriefCard(props: HubPrepBriefCardProps) {
  const { clientId } = useActiveSubject();
  const { tenantId } = useOwnedWorkspaceSubject();
  if (clientId || tenantId) {
    return null;
  }
  return <OwnAccountHubPrepBriefCard {...props} />;
}

/**
 * The card's state machine, in precedence order: debrief override, then
 * upcoming, then add-event. At most one renders; while a read that could
 * change the answer is still pending, nothing renders (unknown is not empty).
 *
 * - debrief: the most recent SHARED event (a registry entry one of this
 *   opponent's tournament blocks resolves to) whose SERVER status is in the
 *   fourteen-day window. Candidate order is most recent display end date,
 *   ties broken by `entryKey` ascending.
 * - upcoming: the nearest upcoming entry whose brief lists this opponent as
 *   likely, nearest by start date, ties broken by `entryKey` ascending.
 * - later-events (code review IN-01): none of the nearest
 *   `MAX_PREP_BRIEF_READS` upcoming entries lists this opponent but more
 *   upcoming entries exist beyond the read cap, so the copy says only what is
 *   known and the door goes to the tournaments page.
 * - add-event: neither, so the door goes to the tournaments page.
 */
function OwnAccountHubPrepBriefCard({
  opponentIdentity,
  opponentTag,
  resolveOpponent,
  tournamentBlocks,
}: HubPrepBriefCardProps) {
  const { t, i18n } = useTranslation();
  const {
    data: entries,
    isPending: entriesPending,
    isError: entriesError,
  } = useTournamentEntries();
  // A lazy `useState` initializer is the sanctioned one-time `Date.now()`
  // read (React Compiler forbids a bare call in the render body).
  const [now] = useState(() => Date.now());

  // Upcoming: one definition of "upcoming" (`listUpcomingEntries`, shared
  // with the dashboard slot), nearest first with the entryKey tiebreak. Only
  // the nearest `MAX_PREP_BRIEF_READS` are read — the cap `usePrepBriefs`
  // enforces itself (code review IN-03) — which bounds a hub visit's fan-out.
  const allUpcoming = useMemo(
    () => (entries ? listUpcomingEntries(entries, now) : []),
    [entries, now],
  );
  const upcomingCandidates = useMemo(
    () => allUpcoming.slice(0, MAX_PREP_BRIEF_READS),
    [allUpcoming],
  );
  const upcomingKeys = useMemo(
    () => upcomingCandidates.map((entry) => entry.entryKey),
    [upcomingCandidates],
  );
  const upcomingBriefs = usePrepBriefs(upcomingKeys);

  // Debrief candidate, ORIGIN BEFORE TIMING (review C1-H7): an admin-imported
  // entry is dropped before any date is read, mirroring the upcoming
  // predicate's own Phase 30.3 Gate 6 ordering.
  const debriefCandidate = useMemo(() => {
    if (!entries) {
      return null;
    }
    const shared: TournamentEntry[] = [];
    for (const block of tournamentBlocks) {
      const entry = resolveTournamentEntry(block, entries);
      if (!entry || isAdminImportedEntry(entry)) {
        continue;
      }
      shared.push(entry);
    }
    return findMostRecentPastEntry(shared, now);
  }, [entries, tournamentBlocks, now]);
  // Review mode is the SERVER's answer (28-CONTEXT.md "⚠ ONE CORRECTION"; the destination decides via `derivePrepSurfaceMode`), never an entry-date comparison.
  const debriefQuery = usePrepBrief(debriefCandidate?.entry.entryKey);

  if (entriesPending || entriesError) {
    return null;
  }

  // Code review WEB-01: a PENDING debrief status is unknown, and unknown is
  // not empty — the debrief override outranks every later state, so any door
  // drawn now could be retracted when the status lands. Render nothing. An
  // ERRORED status still falls through, so a failing endpoint never hides
  // the card for good.
  if (debriefCandidate && debriefQuery.isPending) {
    return null;
  }

  if (debriefCandidate && debriefQuery.isSuccess && isDebriefWindowOpen(debriefQuery.data, now)) {
    return (
      <HubPrepBriefShell
        title={t('opponents.hub.prepBrief.title')}
        state="debrief"
        body={t('opponents.hub.prepBrief.debrief', {
          eventName: debriefCandidate.entry.eventName,
          date: formatEntryDate(debriefCandidate.endMs, i18n.language),
        })}
        doorLabel={t('opponents.hub.prepBrief.debriefCta')}
        doorTo={`/tournaments/${debriefCandidate.entry.entryKey}/prep`}
      />
    );
  }

  const upcoming = resolveUpcoming({
    candidates: upcomingCandidates,
    briefs: upcomingBriefs,
    opponentIdentity,
    resolveOpponent,
  });

  // Unknown is not empty: an unresolved brief read never becomes the
  // add-event state.
  if (upcoming.kind === 'unknown') {
    return null;
  }

  if (upcoming.kind === 'found') {
    return (
      <HubPrepBriefShell
        title={t('opponents.hub.prepBrief.title')}
        state="upcoming"
        body={t('opponents.hub.prepBrief.upcoming', {
          opponentTag,
          eventName: upcoming.entry.eventName,
          date: formatEntryDate(upcoming.entry.firstSetAt, i18n.language),
        })}
        doorLabel={t('opponents.hub.prepBrief.upcomingCta')}
        doorTo={`/tournaments/${upcoming.entry.entryKey}/prep`}
      />
    );
  }

  // Code review IN-01: upcoming entries past the read cap were never read, so
  // "none of the nearest listed this opponent" is all that is known — the
  // opponent may be listed on a later one. Say exactly that, never "add an
  // upcoming event" to a user who already has events beyond the cap.
  if (allUpcoming.length > upcomingCandidates.length) {
    return (
      <HubPrepBriefShell
        title={t('opponents.hub.prepBrief.title')}
        state="laterEvents"
        body={t('opponents.hub.prepBrief.laterEvents', { opponentTag })}
        doorLabel={t('opponents.hub.prepBrief.addEventCta')}
        doorTo="/tournaments"
      />
    );
  }

  return (
    <HubPrepBriefShell
      title={t('opponents.hub.prepBrief.title')}
      state="addEvent"
      body={t('opponents.hub.prepBrief.addEvent', { opponentTag })}
      doorLabel={t('opponents.hub.prepBrief.addEventCta')}
      doorTo="/tournaments"
    />
  );
}

/**
 * Walks the upcoming candidates nearest first and returns the first whose
 * brief lists this opponent. Every likely-opponent name goes through the
 * hub's resolver, so a name stored under an alias still matches the
 * resolved identity. A pending or errored read before a match is found makes
 * the answer unknown.
 */
function resolveUpcoming({
  candidates,
  briefs,
  opponentIdentity,
  resolveOpponent,
}: {
  candidates: readonly RoutableTournamentEntry[];
  briefs: ReturnType<typeof usePrepBriefs>;
  opponentIdentity: string;
  resolveOpponent: (match: { opponent: string }) => string;
}): UpcomingResolution {
  for (let index = 0; index < candidates.length; index += 1) {
    const query = briefs[index];
    if (!query || query.isPending || query.isError) {
      return { kind: 'unknown' };
    }
    const likely = query.data.brief?.likelyOpponents ?? {};
    const listed = Object.keys(likely).some(
      (name) => resolveOpponent({ opponent: name }) === opponentIdentity,
    );
    if (listed) {
      return { kind: 'found', entry: candidates[index]! };
    }
  }
  return { kind: 'none' };
}

/** The card's one chrome: muted icon, title, one copy line, exactly one outline door. */
function HubPrepBriefShell({
  title,
  state,
  body,
  doorLabel,
  doorTo,
}: {
  title: string;
  state: 'debrief' | 'upcoming' | 'laterEvents' | 'addEvent';
  body: string;
  doorLabel: string;
  doorTo: string;
}) {
  return (
    <Card data-testid="hub-prep-brief-card" data-state={state}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock aria-hidden="true" className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-pretty break-words">{body}</p>
        <Button asChild size="sm" variant="outline">
          <Link to={doorTo}>{doorLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
