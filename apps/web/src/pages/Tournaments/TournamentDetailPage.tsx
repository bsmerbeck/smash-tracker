import { useCallback, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import {
  anchorKey,
  matchesForEntry,
  buildSetTimeline,
  splitTournamentBlocks,
  stageBucketId,
  trimmedEventKey,
} from '@smash-tracker/shared';
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
import { RulesetOverrideSection } from './components/RulesetOverrideSection';
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

  /**
   * CR-03/WR-04 (38-REVIEW-FIX): a per-STAGE, per-PROXIMITY-BLOCK
   * event-anchor key — never `entry.entryKey` (the tournament registry's own
   * foreign key, unrelated to `packages/shared/src/evidence/eventSeries.ts`'s
   * anchor-key format). `StageDetailPage.tsx` resolves its `event=` param by
   * looking up `buildStageEventSeries({ matches, stageId, ... })`'s own
   * anchors, and that builder scopes matches by STAGE first, groups by name,
   * then calls `splitTournamentBlocks` — which starts a NEW anchor whenever
   * two consecutive plays on that stage are more than
   * `EVENT_ANCHOR_PROXIMITY_MS` (4 days) apart. A multi-day entry can
   * therefore split a single stage into more than one anchor block, each
   * with its OWN key (its own block's min time), and each block now also
   * carries its own `startMs`/`endMs` (WR-05: needed to span every block in
   * a from/to window — see `stageAggregateLinkParams` below). CR-03's
   * original fix computed exactly one key per stage (the EARLIEST block's),
   * which under-represents a later block's picks — WR-04 fixes that by
   * computing every block per stage here (calling the engine's own exported
   * `splitTournamentBlocks`, never re-implementing the proximity rule) and
   * resolving the correct block for a SPECIFIC match via `eventKeyForStage`
   * below (the Advisor Retrospective case, where each pick names its own
   * played game — untouched by WR-05). `entryMatches` are already bounded to
   * this one tournament occurrence (`matchesForEntry`'s
   * eventName[+tournamentName]+time-window filter), so every match here
   * shares one name and the per-stage blocks computed here match what
   * `buildStageEventSeries` independently derives for a real, single
   * occurrence of this event.
   */
  const stageEventBlocksByStageId = useMemo(() => {
    const map = new Map<
      number,
      { key: string; matchIds: Set<string>; startMs: number; endMs: number }[]
    >();
    const [firstMatch] = entryMatches;
    if (!firstMatch) {
      return map;
    }
    const name = trimmedEventKey(firstMatch);
    if (name == null) {
      return map;
    }
    const matchesByStage = new Map<number, Match[]>();
    for (const match of entryMatches) {
      const stageId = stageBucketId(match);
      const group = matchesByStage.get(stageId);
      if (group) {
        group.push(match);
      } else {
        matchesByStage.set(stageId, [match]);
      }
    }
    for (const [stageId, stageMatches] of matchesByStage) {
      const sorted = [...stageMatches].sort((a, b) => a.time - b.time);
      const blocks = splitTournamentBlocks(sorted).map((block) => ({
        key: anchorKey('tournament', name, block[0]!.time),
        matchIds: new Set(block.map((m) => m.id)),
        startMs: block[0]!.time,
        endMs: block[block.length - 1]!.time,
      }));
      map.set(stageId, blocks);
    }
    return map;
  }, [entryMatches]);
  const eventKeyForStage = useCallback(
    (stageId: number, matchId?: string): string | undefined => {
      const blocks = stageEventBlocksByStageId.get(stageId);
      if (!blocks || blocks.length === 0) {
        return undefined;
      }
      if (matchId != null) {
        const owningBlock = blocks.find((block) => block.matchIds.has(matchId));
        if (owningBlock) {
          return owningBlock.key;
        }
      }
      // Blocks are pushed in ascending time order by `splitTournamentBlocks`,
      // so the last one is the most recent.
      return blocks[blocks.length - 1]!.key;
    },
    [stageEventBlocksByStageId],
  );

  /**
   * WR-05 (38-REVIEW-FIX): the "Stages Played" aggregate row's OWN
   * drill-down params — never `eventKeyForStage`'s no-`matchId` branch. That
   * row has no single match of its own; its displayed W-L/games figure
   * (`CharactersAndStages.tsx`'s `StagesCard`) already sums EVERY block for
   * that stage, but a single `event=<key>` link can only ever resolve to ONE
   * block on `StageDetailPage.tsx` — for a stage split across more than one
   * proximity block, that landed the user on a subset smaller than what the
   * row promised, with nothing on the destination disclosing the narrowing
   * (its only "subset" signal, the `eventLabel` subtitle, is just the
   * tournament's name — identical across every block of the same event).
   *
   * When the stage has exactly one block, this returns the SAME
   * `{ eventKey }` `eventKeyForStage` would have (byte-identical link for the
   * common case). When it has more than one, this returns an inclusive
   * `from`/`to` date window spanning every block's own match times instead —
   * `StageDetailPage.tsx` narrows every region by that window exactly as it
   * would by `event=` (see its `sourceMatches`/`terminusAxes`), so the
   * destination lists exactly the games this row counts. No new URL param:
   * `from`/`to` are `drillDownParams.ts`'s own existing axes.
   *
   * Known, accepted limitation: unlike `event=` (which matches by this
   * entry's own block membership), a `from`/`to` window matches by RAW
   * `match.time`, so it could in principle also admit a DIFFERENT tournament
   * entry's games on the same stage if that entry shares this one's event
   * name and its games happen to fall inside the window (`trimmedEventKey`
   * groups only by name, not by `tournamentName`+time the way
   * `matchesForEntry` disambiguates entries — see that function's own
   * "two different weeklies both hosting 'Ultimate Singles'" comment for the
   * same class of tradeoff already accepted elsewhere in this codebase).
   * There is no existing drill-down axis that scopes to one entry's specific
   * match ids, and adding one is out of scope here — the alternative (this
   * fix's predecessor: an undisclosed subset on EVERY multi-block entry) is
   * the strictly more common and more actively misleading failure mode this
   * finding named, so the rare cross-entry edge case is accepted rather than
   * reverting to a silent narrowing.
   */
  const stageAggregateLinkParams = useCallback(
    (stageId: number): { eventKey?: string; from?: number; to?: number } | undefined => {
      const blocks = stageEventBlocksByStageId.get(stageId);
      if (!blocks || blocks.length === 0) {
        return undefined;
      }
      if (blocks.length === 1) {
        return { eventKey: blocks[0]!.key };
      }
      const startMs = Math.min(...blocks.map((block) => block.startMs));
      const endMs = Math.max(...blocks.map((block) => block.endMs));
      return { from: startMs, to: endMs };
    },
    [stageEventBlocksByStageId],
  );

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
      <CharactersAndStages
        matches={entryMatches}
        stageAggregateLinkParams={stageAggregateLinkParams}
      />
      {/* EVID-04 (D-10, D-18): renders for every entry including
          admin-imported ones — plan 37-06's retrospective grades historical
          picks under whichever ruleset applied to that event, and this is
          where that ruleset is disclosed and (own-account only) edited. */}
      <RulesetOverrideSection entry={entry} />
      {retrospective && (
        <AdvisorRetrospective retrospective={retrospective} eventKeyForStage={eventKeyForStage} />
      )}
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
