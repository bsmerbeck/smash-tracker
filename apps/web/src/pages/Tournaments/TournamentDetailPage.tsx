import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { matchesForEntry, buildSetTimeline } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useMatches } from '@/hooks/useMatches';
import { usePrepBrief } from '@/hooks/usePrepBrief';
import { useIsDemoAccount } from '@/hooks/useIsDemoAccount';
import { isAdminImportedEntry } from '@/lib/historicalTournament';
import { TournamentHeader } from './components/TournamentHeader';
import { EventResults } from './components/EventResults';
import { ImportedSnapshotNotice } from './components/ImportedSnapshotNotice';
import { SetTimeline } from './components/SetTimeline';
import { CharactersAndStages } from './components/CharactersAndStages';
import { AdvisorRetrospective } from './components/AdvisorRetrospective';
import { GenerateRecapDialog } from './components/GenerateRecapDialog';
import { buildRetrospective } from './lib/retrospective';

function NotFoundState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t('tournaments.notFound.title')}</h1>
      <p className="max-w-md text-muted-foreground">{t('tournaments.notFound.body')}</p>
      <Button asChild className="mt-2">
        <Link to="/trends">{t('tournaments.notFound.back')}</Link>
      </Button>
    </div>
  );
}

/**
 * V4 Phase B / V5 Phase B: tournament detail page — header (with
 * seed->placement badge + start.gg deep link), Event Results (top-8
 * standings), set-by-set timeline, characters/stages summary, and the
 * Advisor Retrospective. Reached by clicking a tournament row in Trends, or
 * by direct URL (`/tournaments/:eventId`); an unknown/foreign entryKey
 * renders a friendly not-found state rather than crashing on a missing
 * entry.
 *
 * Phase 7: the route's `:eventId` path segment now carries the
 * source-agnostic `entryKey` (the URL param label is unchanged to avoid
 * touching the route table, but its value is looked up against
 * `entry.entryKey`, never a parsed numeric start.gg `eventId` — parry.gg
 * entries have no numeric id at all). `GET /api/tournaments` always fills
 * `entryKey` from the RTDB child key on read, so every entry the page can
 * see carries one. start.gg-only affordances (the "View on start.gg" link,
 * the Event Results standings table) already gate on the presence of
 * `slug`/`eventSlug`/`topStandings` rather than on `source` directly, so a
 * parry.gg entry (which never has those fields) renders its available data
 * gracefully with no code change needed in the child components.
 *
 * Phase 7 (RECAP-01/02): a "Generate recap" action opens `GenerateRecapDialog`
 * when the entry has processed at least one completed set (`setsPlayed >= 1`
 * — a synced tournament with no processable sets yet has nothing
 * deterministic to summarize). Every entry on this page already belongs to
 * the signed-in owner (`useTournamentEntries` scopes to the caller's own
 * registry), so no separate ownership check is needed client-side; the
 * server independently enforces it (T-07-05-02).
 *
 * Phase 26 (PREP-01/04, D-01/D-03/D-13/D-14): a "Start prep brief"/"Open prep
 * brief" action lives in the same action row. `usePrepBrief` is called
 * unconditionally (it's a no-op query while `entry?.entryKey` is undefined),
 * and its resolved `activated` flag decides the CTA: `reopen` once a brief
 * exists — regardless of whether the event date has passed, since an
 * existing brief is never hidden (D-03) — or `start` when none exists yet
 * AND the event is upcoming (`firstSetAt > Date.now()`, D-01). While the
 * query is still pending, no prep action renders at all: an unresolved
 * activation state is not the same as "not activated" (the 260725-juj
 * unknown-is-not-zero lesson applied to UI eligibility).
 */
export function TournamentDetailPage() {
  const { t } = useTranslation();
  const { eventId } = useParams<{ eventId: string }>();
  const { data: entries, isLoading: entriesLoading } = useTournamentEntries();
  const { data: allMatches = [], isLoading: matchesLoading } = useMatches();
  // Phase 30.3 (Gate 6): recap creation (`GenerateRecapDialog`, which mints
  // a bearer-token share) is disabled-with-explanation for a demo/research
  // account (owner/Codex hard gate) — independent of this page's existing
  // admin-imported origin guard on the PREP cta below, which is a different
  // concern (historical-event ineligibility, not account-level policy).
  const isDemoAccount = useIsDemoAccount();
  const [recapDialogOpen, setRecapDialogOpen] = useState(false);
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch (see ClaimStatusBadge); a stale "now" across re-renders is
  // harmless here since the upcoming/past determination only needs to be
  // right as of the render that used it.
  const [now] = useState(() => Date.now());

  const entry = useMemo(() => {
    if (!entries || !eventId) {
      return undefined;
    }
    return entries.find((e) => e.entryKey === eventId);
  }, [entries, eventId]);

  const entryMatches = useMemo(() => {
    if (!entry) {
      return [];
    }
    return matchesForEntry(allMatches, entry);
  }, [allMatches, entry]);

  const timeline = useMemo(() => buildSetTimeline(entryMatches), [entryMatches]);

  const retrospective = useMemo(() => {
    if (!entry) {
      return null;
    }
    return buildRetrospective(allMatches, entryMatches, entry);
  }, [allMatches, entryMatches, entry]);

  const prepBriefQuery = usePrepBrief(entry?.entryKey ?? undefined);

  if (entriesLoading || matchesLoading) {
    return <div className="text-muted-foreground">{t('tournaments.loading')}</div>;
  }

  if (!entry) {
    return <NotFoundState />;
  }

  const canGenerateRecap = entry.setsPlayed >= 1;

  // Phase 30.3 (Gate 4, owner directive): an admin-imported historical
  // snapshot is a PAST public-data record — registration/seeded/live prep
  // controls must NEVER render for it, regardless of what its imported
  // timestamps look like (a mis-recorded future startAtMs/firstSetAt must
  // not resurrect the "Start prep brief" CTA).
  const isImported = isAdminImportedEntry(entry);

  // 260725-juj: a pending or failed prep-brief query is UNKNOWN, not "no
  // brief exists" — mirrors DashboardPrepActionSlot.tsx's isPending ||
  // isError handling so this CTA never guesses "Start" over an already-
  // activated brief just because the read errored.
  const prepCtaState: 'start' | 'reopen' | 'none' = isImported
    ? 'none'
    : prepBriefQuery.isPending || prepBriefQuery.isError
      ? 'none'
      : prepBriefQuery.data?.activated
        ? 'reopen'
        : entry.firstSetAt > now
          ? 'start'
          : 'none';

  const showActionRow = canGenerateRecap || prepCtaState !== 'none';

  return (
    <div className="flex flex-col gap-6">
      {showActionRow && (
        <div className="flex justify-end gap-2">
          {prepCtaState !== 'none' && entry.entryKey && (
            // Plain navigation only — no onClick/mutation on this CTA. That
            // is what lets the destination page's own mount own activation
            // (POST /api/prep/:entryKey/activate) while this GET stays a
            // write-free read (D-12). Adding an "activate on click" handler
            // here would break that separation.
            <Button asChild data-testid="tournament-prep-cta">
              <Link to={`/tournaments/${entry.entryKey}/prep`}>
                {t(prepCtaState === 'reopen' ? 'prep.cta.open' : 'prep.cta.start')}
              </Link>
            </Button>
          )}
          {canGenerateRecap && (
            <Button
              type="button"
              onClick={() => setRecapDialogOpen(true)}
              disabled={isDemoAccount}
              title={isDemoAccount ? t('demo.disabledReason') : undefined}
            >
              {t('tournaments.recap.generateButton')}
            </Button>
          )}
        </div>
      )}
      <ImportedSnapshotNotice entry={entry} />
      <TournamentHeader entry={entry} />
      <EventResults entry={entry} entryMatches={entryMatches} />
      <SetTimeline entry={entry} sets={timeline.sets} otherMatches={timeline.otherMatches} />
      <CharactersAndStages matches={entryMatches} />
      {retrospective && <AdvisorRetrospective retrospective={retrospective} />}
      {canGenerateRecap && entry.entryKey && (
        <GenerateRecapDialog
          entryKey={entry.entryKey}
          open={recapDialogOpen}
          onOpenChange={setRecapDialogOpen}
        />
      )}
    </div>
  );
}
